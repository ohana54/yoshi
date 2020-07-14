import path from 'path';
// eslint-disable-next-line import/no-extraneous-dependencies
import webpack from 'webpack';
import {
  validateServerEntry,
  createServerEntries,
} from 'yoshi-common/build/webpack-utils';
// @ts-ignore
import { StatsWriterPlugin } from 'webpack-stats-plugin';
import { createBaseWebpackConfig as createCommonWebpackConfig } from 'yoshi-common/build/webpack.config';
import { defaultEntry } from 'yoshi-helpers/build/constants';
import { Config } from 'yoshi-config/build/config';
import {
  isTypescriptProject,
  isSingleEntry,
  inTeamCity,
  isProduction as isProductionQuery,
  inMasterTeamCity,
} from 'yoshi-helpers/build/queries';
import { STATICS_DIR, SERVER_ENTRY, SRC_DIR } from 'yoshi-config/build/paths';
import ManifestPlugin from 'yoshi-common/build/manifest-webpack-plugin';
import { isObject } from 'lodash';
import SentryWebpackPlugin from '@sentry/webpack-plugin';
import { getProjectArtifactVersion } from 'yoshi-helpers/utils';
import { PackageGraphNode } from './load-package-graph';
import { isThunderboltElementModule, isThunderboltAppModule } from './utils';

const useTypeScript = isTypescriptProject();
const isProduction = isProductionQuery();

const defaultSplitChunksConfig = {
  chunks: 'all',
  name: 'commons',
  minChunks: 2,
};

function createBaseWebpackConfig(
  ...args: Parameters<typeof createCommonWebpackConfig>
) {
  const [options] = args;
  const config = createCommonWebpackConfig(...args);

  if (isProduction && !options.isDev) {
    config.plugins!.push(
      new StatsWriterPlugin({
        filename: `${options.configName}.${options.target}.chunks.min.json`,
        // https://webpack.js.org/configuration/stats/#stats
        stats: {
          all: false,
          assets: true,
        },
        transform(data: webpack.Stats.ToJsonOutput) {
          return JSON.stringify({
            name: `${options.configName}.${options.target}`,
            chunks: data.assetsByChunkName,
          });
        },
      }),
    );
  }

  return config;
}

const createDefaultOptions = (
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  rootConfig: Config,
) => {
  const separateCss =
    pkg.config.separateCss === 'prod'
      ? inTeamCity() || isProduction
      : pkg.config.separateCss;

  return {
    name: pkg.config.name as string,
    useTypeScript,
    typeCheckTypeScript: false, // useTypeScript,
    useAngular: pkg.config.isAngularProject,
    devServerUrl: pkg.config.servers.cdn.url,
    cssModules: pkg.config.cssModules,
    separateCss,
    includeInTranspilation: [
      ...[...apps, ...libs].map(({ location }) => path.join(location, SRC_DIR)),
      ...rootConfig.externalUnprocessedModules.map(
        (m) => new RegExp(`node_modules/${m}`),
      ),
    ],
    umdNamedDefine: pkg.config.umdNamedDefine,
  };
};

export function createClientWebpackConfig(
  rootConfig: Config,
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  {
    isDev,
    isHot,
    suricate,
    isAnalyze,
    forceEmitSourceMaps,
    forceEmitStats,
  }: {
    isDev?: boolean;
    isHot?: boolean;
    suricate?: boolean;
    isAnalyze?: boolean;
    forceEmitSourceMaps?: boolean;
    forceEmitStats?: boolean;
  } = {},
): webpack.Configuration {
  const entry = pkg.config.entry || defaultEntry;

  const defaultOptions = createDefaultOptions(pkg, libs, apps, rootConfig);

  const clientConfig = createBaseWebpackConfig({
    cwd: pkg.location,
    configName: 'client',
    target: 'web',
    isDev,
    isHot,
    suricate,
    isMonorepo: true,
    isAnalyze,
    forceEmitSourceMaps,
    forceEmitStats,
    exportAsLibraryName: pkg.config.exports,
    enhancedTpaStyle: pkg.config.enhancedTpaStyle,
    tpaStyle: pkg.config.tpaStyle,
    separateStylableCss: pkg.config.separateStylableCss,
    createEjsTemplates: pkg.config.experimentalBuildHtml,
    useCustomSourceMapPlugin:
      isThunderboltElementModule(pkg) || isThunderboltAppModule(pkg),
    // Because CSS assets are inlined in the initial HTML response, images
    // and other assets they reference has to have absolute URLs
    useAbsoluteUrlsForCssAssets:
      isThunderboltElementModule(pkg) || isThunderboltAppModule(pkg),
    ...defaultOptions,
  });

  if (isThunderboltElementModule(pkg)) {
    clientConfig.optimization!.runtimeChunk = false;
  }

  if (isThunderboltAppModule(pkg)) {
    if (inMasterTeamCity() && process.env.PUBLISH_SENTRY) {
      clientConfig.plugins!.push(
        new SentryWebpackPlugin({
          include: path.join(pkg.location, STATICS_DIR),
          release: getProjectArtifactVersion(pkg.name),
        }),
      );
    }
  }

  clientConfig.entry = isSingleEntry(entry) ? { app: entry as string } : entry;
  clientConfig.resolve!.alias = pkg.config.resolveAlias;
  clientConfig.externals = pkg.config.externals;

  const useSplitChunks = pkg.config.splitChunks;

  // Thunderbolt and editor elements need a smaller version
  // of the stats to be uploaded to the cdn
  // This is being analyzed later on during render time
  if (isThunderboltElementModule(pkg) || isThunderboltAppModule(pkg)) {
    let statsFileName: string | null = null;

    // build command, production bundle
    if (isProduction && !isDev) {
      statsFileName = 'stats.min.json';
    }

    // start command, development bundle
    if (!isProduction && isDev) {
      statsFileName = 'stats.json';
    }

    // We want to emit the production stats only when running yoshi build
    // We want to emit the development stats only when running yoshi start
    if (statsFileName) {
      clientConfig.plugins!.push(
        new StatsWriterPlugin({
          filename: statsFileName,
          // https://webpack.js.org/configuration/stats/#stats
          stats: {
            all: false,
            chunkGroups: true,
            publicPath: true,
          },
          transform(data: webpack.Stats.ToJsonOutput) {
            // By default, the stats file contain spaces an indentation
            // This verifies it's minified
            return JSON.stringify(data);
          },
        }),
      );
    }
  }

  if (useSplitChunks) {
    const splitChunksConfig = isObject(useSplitChunks)
      ? useSplitChunks
      : defaultSplitChunksConfig;

    clientConfig!.optimization!.splitChunks = splitChunksConfig as webpack.Options.SplitChunksOptions;
  }

  return clientConfig;
}

export function createServerWebpackConfig(
  rootConfig: Config,
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  { isDev, isHot }: { isDev?: boolean; isHot?: boolean } = {},
): webpack.Configuration {
  const defaultOptions = createDefaultOptions(pkg, libs, apps, rootConfig);

  const serverConfig = createBaseWebpackConfig({
    cwd: pkg.location,
    configName: 'server',
    target: 'node',
    isDev,
    isHot,
    isMonorepo: true,
    nodeExternalsWhitelist: libs.map((pkg) => new RegExp(pkg.name)),
    useAssetRelocator: pkg.config.experimentalUseAssetRelocator,
    forceMinimizeServer: isThunderboltElementModule(pkg),
    serverExternals: pkg.config.serverExternals,
    ...defaultOptions,
  });

  if (isThunderboltElementModule(pkg)) {
    // output to /dist/statics so it's available for thunderbolt to download
    serverConfig.output!.path = path.join(pkg.location, STATICS_DIR);

    // create only 1 file regardless of dynamic imports so it's easier to download
    serverConfig.plugins!.push(
      new webpack.optimize.LimitChunkCountPlugin({
        maxChunks: 1,
      }),
    );

    // use cheap source maps to make download faster
    serverConfig.devtool = 'inline-cheap-source-map';
  }

  serverConfig.entry = async () => {
    const serverEntry = validateServerEntry({
      cwd: pkg.location,
      extensions: serverConfig.resolve!.extensions as Array<string>,
      yoshiServer: pkg.config.yoshiServer,
    });

    let entryConfig = pkg.config.yoshiServer
      ? createServerEntries(serverConfig.context as string, pkg.location)
      : {};

    if (serverEntry) {
      entryConfig = { ...entryConfig, [SERVER_ENTRY]: serverEntry };
    }

    return entryConfig;
  };

  return serverConfig;
}

export function createWebWorkerWebpackConfig(
  rootConfig: Config,
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  {
    isDev,
    isHot,
    isAnalyze,
    forceEmitStats,
  }: {
    isDev?: boolean;
    isHot?: boolean;
    isAnalyze?: boolean;
    forceEmitStats?: boolean;
  } = {},
): webpack.Configuration {
  const defaultOptions = createDefaultOptions(pkg, libs, apps, rootConfig);

  const workerConfig = createBaseWebpackConfig({
    cwd: pkg.location,
    configName: 'web-worker',
    target: isThunderboltElementModule(pkg) ? 'async-webworker' : 'webworker',
    isDev,
    isHot,
    isMonorepo: true,
    createEjsTemplates: pkg.config.experimentalBuildHtml,
    isAnalyze,
    forceEmitStats,
    ...defaultOptions,
  });

  // Use inline source maps since Thunderbolt loads worker as a blob locally
  if (!isProduction) {
    workerConfig.devtool = 'inline-source-map';
  }

  workerConfig.output!.library = '[name]';
  workerConfig.output!.libraryTarget = 'umd';
  workerConfig.output!.globalObject = 'self';

  workerConfig.entry = pkg.config.webWorkerEntry;
  workerConfig.resolve!.alias = pkg.config.webWorkerResolveAlias;
  workerConfig.externals = pkg.config.webWorkerExternals;

  if (pkg.config.webWorkerSplitChunks) {
    workerConfig.optimization!.splitChunks = pkg.config.webWorkerSplitChunks;
  }

  return workerConfig;
}

export function createWebWorkerServerWebpackConfig(
  rootConfig: Config,
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  { isDev, isHot }: { isDev?: boolean; isHot?: boolean } = {},
): webpack.Configuration {
  const defaultOptions = createDefaultOptions(pkg, libs, apps, rootConfig);

  const workerConfig = createBaseWebpackConfig({
    cwd: pkg.location,
    configName: 'web-worker-server',
    target: isThunderboltElementModule(pkg) ? 'async-webworker' : 'webworker',
    isDev,
    isHot,
    isMonorepo: true,
    createWorkerManifest: false,
    overrideDefinePluginBrowserEnvVar: false,
    ...defaultOptions,
  });

  workerConfig.output!.library = '[name]';
  workerConfig.output!.libraryTarget = 'umd';
  workerConfig.output!.globalObject = 'self';

  workerConfig.entry = pkg.config.webWorkerServerEntry;

  workerConfig.plugins!.push(
    new webpack.optimize.LimitChunkCountPlugin({
      maxChunks: 1,
    }),
  );

  return workerConfig;
}

export function createSiteAssetsWebpackConfig(
  rootConfig: Config,
  pkg: PackageGraphNode,
  libs: Array<PackageGraphNode>,
  apps: Array<PackageGraphNode>,
  {
    isDev,
    forceEmitSourceMaps,
    forceEmitStats,
    isAnalyze,
    target,
    transpileCarmiOutput,
    disableEmitSourceMaps = false,
    forceMinimizeServer = false,
    keepFunctionNames = false,
  }: {
    isDev?: boolean;
    forceEmitSourceMaps?: boolean;
    forceEmitStats?: boolean;
    isAnalyze?: boolean;
    target: 'web' | 'node';
    transpileCarmiOutput?: boolean;
    disableEmitSourceMaps?: boolean;
    forceMinimizeServer?: boolean;
    keepFunctionNames?: boolean;
  },
): webpack.Configuration {
  const entry = pkg.config.entry || defaultEntry;

  const defaultOptions = createDefaultOptions(pkg, libs, apps, rootConfig);

  const config = createBaseWebpackConfig({
    cwd: pkg.location,
    configName: 'site-assets',
    target,
    isDev,
    isMonorepo: true,
    isAnalyze,
    forceEmitSourceMaps,
    forceEmitStats,
    // We don't have any server externals for `site assets` bundle
    // So with empty object, we'll be sure that no default externals value will be applied
    serverExternals: target === 'node' ? {} : undefined,
    forceMinimizeServer,
    disableEmitSourceMaps,
    exportAsLibraryName: pkg.config.exports,
    enhancedTpaStyle: pkg.config.enhancedTpaStyle,
    tpaStyle: pkg.config.tpaStyle,
    separateStylableCss: pkg.config.separateStylableCss,
    createEjsTemplates: pkg.config.experimentalBuildHtml,
    keepFunctionNames,
    transpileCarmiOutput,
    ...defaultOptions,
  });

  config.entry = isSingleEntry(entry) ? { app: entry as string } : entry;

  const manifestName = target === 'node' ? 'manifest' : 'manifest-web';

  // for site-assets we have two minified compilations
  // for them to not override each other we'll rename the web one
  config.plugins!.push(
    new ManifestPlugin({ fileName: manifestName, isDev: isDev as boolean }),
  );

  if (target === 'web') {
    // use a umd bundle for the web bundles
    config.output!.libraryTarget = 'umd';
  }

  config.output!.path = path.join(pkg.location, STATICS_DIR);
  config.output!.filename = isDev
    ? '[name].bundle.js'
    : '[name].[contenthash:8].bundle.min.js';
  config.output!.chunkFilename = isDev
    ? '[name].chunk.js'
    : '[name].[contenthash:8].chunk.min.js';

  return config;
}
