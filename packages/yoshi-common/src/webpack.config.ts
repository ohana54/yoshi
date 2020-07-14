import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import webpack, { ExternalsElement, RuleSetCondition } from 'webpack';
import {
  SRC_DIR,
  STATICS_DIR,
  TSCONFIG_FILE,
  BUILD_DIR,
  SERVERLESS_SCOPE_BUILD_DIR,
  PUBLIC_DIR,
  ASSETS_DIR,
  TEMPLATES_DIR,
  TEMPLATES_BUILD_DIR,
  SERVER_CHUNKS_DIR,
  STATS_FILE,
} from 'yoshi-config/build/paths';
import resolve from 'resolve';
import {
  isProduction as checkIsProduction,
  inTeamCity as checkInTeamCity,
} from 'yoshi-helpers/build/queries';
// @ts-ignore - missing types
import { StatsWriterPlugin } from 'webpack-stats-plugin';
// @ts-ignore - missing types
import ModuleNotFoundPlugin from 'react-dev-utils/ModuleNotFoundPlugin';
import getCacheIdentifier from 'react-dev-utils/getCacheIdentifier';
import CaseSensitivePathsPlugin from 'case-sensitive-paths-webpack-plugin';
import {
  toIdentifier,
  getProjectArtifactId,
  getServerlessScope,
  getServerlessBase,
} from 'yoshi-helpers/utils';
import TerserPlugin from 'terser-webpack-plugin';
import OptimizeCSSAssetsPlugin from 'optimize-css-assets-webpack-plugin';
import cssnano from 'cssnano';
import CopyPlugin from 'copy-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import importCwd from 'import-cwd';
import { BundleAnalyzerPlugin } from 'webpack-bundle-analyzer';
import globby from 'globby';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import InterpolateHtmlPlugin from 'react-dev-utils/InterpolateHtmlPlugin';
// @ts-ignore - missing types
import RtlCssPlugin from 'rtlcss-webpack-plugin';
import TpaStyleWebpackPlugin from 'tpa-style-webpack-plugin';
// @ts-ignore - missing types
import { mdsvex } from 'mdsvex';
import WebpackBar from 'webpackbar';
import isCi from 'is-ci';
import {
  stripOrganization,
  getProjectArtifactVersion,
} from 'yoshi-helpers/build/utils';
import { resolveNamespaceFactory } from './@stylable/node';
import StylableWebpackPlugin, {
  globalRuntimeId,
} from './@stylable/webpack-plugin';
import shouldTranspileFile from './utils/should-transpile-file';
import InlineChunkHtmlPlugin from './html-inline-plugin';
import { localIdentName } from './utils/constants';
import ExportDefaultPlugin from './export-default-plugin';
import { calculatePublicPath } from './webpack-utils';
import ManifestPlugin from './manifest-webpack-plugin';
import createBabelConfig from './create-babel-config';
import SveltePreprocessSSR from './svelte-server-side-preprocess';
import { asyncWebWorkerTarget } from './AsyncWebWorkerTarget/AsyncWebWorkerTarget';
import { sourceMapPlugin } from './source-map-plugin';
import HtmlRenderingDataPlugin from './html-rendering-data-plugin';

export type CompilationTarget =
  | 'web'
  | 'node'
  | 'webworker'
  | 'async-webworker';

const isProduction = checkIsProduction();
const inTeamCity = checkInTeamCity();

const disableModuleConcat = process.env.DISABLE_MODULE_CONCATENATION === 'true';

const disableStatsOutput = process.env.DISABLE_WEBPACK_STATS_OUTPUT === 'true';

const customAnalyzerPort: number | null = process.env.ANALYZE_PORT
  ? Number(process.env.ANALYZE_PORT)
  : null;

const reScript = /\.js?$/;
const reStyle = /\.(css|less|scss|sass)$/;
const reAssets = /\.(png|jpg|jpeg|gif|woff|woff2|ttf|otf|eot|wav|mp3)$/;

const staticAssetName = 'media/[name].[hash:8].[ext]';

const sassIncludePaths = ['node_modules', 'node_modules/compass-mixins/lib'];

function addExtensionPrefix(filePath: string, prefix: string) {
  const lastDotIndex = filePath.lastIndexOf('.');
  const extension = filePath.slice(lastDotIndex);

  return `${filePath.slice(0, lastDotIndex)}.${prefix}${extension}`;
}

function prependNameWith(filename: string, prefix: string) {
  return filename.replace(/\.[0-9a-z]+$/i, (match) => `.${prefix}${match}`);
}

function getProgressBarInfo(
  configName: string,
  isDev: boolean,
  isMonorepo: boolean,
  packageName: string,
  target: CompilationTarget,
): {
  name: string;
  color: string;
  reporters: Array<string>;
} {
  const longestNameLength = 19;

  function getObject() {
    switch (configName) {
      case 'client':
        if (isDev) {
          return { name: `Client [debug]`, color: 'blue' };
        }
        return { name: `Client [production]`, color: 'green' };
      case 'web-worker':
        if (isDev) {
          return { name: `Worker [debug]`, color: 'magenta' };
        }
        return { name: `Worker [production]`, color: 'cyan' };
      case 'web-worker-server':
        return { name: `Worker Server`, color: 'orange' };
      case 'server':
        return { name: `Server`, color: 'orange' };
      case 'site-assets':
        if (target === 'web') {
          return { name: `Site Assets [web]`, color: 'green' };
        }
        return { name: `Site Assets [node]`, color: 'cyan' };
      default:
        return { name: configName, color: 'white' };
    }
  }

  const obj = getObject();

  obj.name = obj.name.padEnd(longestNameLength);

  if (isMonorepo) {
    obj.name = `${stripOrganization(packageName)}\n  ${obj.name}`;
  }
  const progressReporter =
    isCi || process.env.PROGRESS_BAR === 'false' ? 'basic' : 'fancy';

  const profileReporter = process.env.PROFILE === 'true' ? ['profile'] : [];

  const reporters = [progressReporter, ...profileReporter];

  return {
    ...obj,
    reporters,
  };
}

const getCommonStylbleWebpackConfig = (name: string) => ({
  optimize: {
    classNameOptimizations: false,
    shortNamespaces: false,
  },
  generate: {
    runtimeStylesheetId: 'namespace',
  },
  resolveNamespace: resolveNamespaceFactory(name),
});

export const getStyleLoaders = ({
  name,
  embedCss = false,
  isDev = false,
  isHot = false,
  cssModules = true,
  experimentalRtlCss = false,
  separateCss = false,
  tpaStyle = false,
  useAbsoluteUrlsForCssAssets = false,
}: {
  name: string;
  embedCss?: boolean;
  isDev?: boolean;
  isHot?: boolean;
  cssModules?: boolean;
  experimentalRtlCss?: boolean;
  separateCss?: boolean;
  tpaStyle?: boolean;
  useAbsoluteUrlsForCssAssets?: boolean;
}): Array<webpack.Rule> => {
  const cssLoaderOptions = {
    camelCase: true,
    sourceMap: separateCss,
    localIdentName: isProduction ? localIdentName.short : localIdentName.long,
    // Make sure every package has unique class names
    hashPrefix: name,
    modules: cssModules,
    // PostCSS, less-loader, sass-loader and resolve-url-loader, so
    // composition will work with import
    importLoaders: 4 + Number(tpaStyle),
  };

  return [
    {
      test: reStyle,
      exclude: /\.st\.css$/,
      rules: [
        ...(embedCss
          ? [
              ...(isHot
                ? [{ loader: 'yoshi-style-dependencies/css-hot-loader' }]
                : []),

              // Process every style asset with either `style-loader`
              // or `mini-css-extract-plugin`
              ...(separateCss
                ? [
                    {
                      loader: MiniCssExtractPlugin.loader,
                      options: {
                        // By default it use publicPath in webpackOptions.output
                        // We are overriding it to restore relative paths in url() calls
                        publicPath: useAbsoluteUrlsForCssAssets
                          ? undefined
                          : '',
                      },
                    },
                  ]
                : [
                    {
                      loader: 'yoshi-style-dependencies/style-loader',
                      options: {
                        // Reuses a single `<style></style>` element
                        singleton: true,
                      },
                    },
                  ]),

              {
                oneOf: [
                  // Files ending with `.global.(css|sass|scss|less)` will be transpiled with
                  // `modules: false`
                  {
                    test: /\.global\.[A-z]*$/,
                    loader: 'yoshi-style-dependencies/css-loader',
                    options: {
                      ...cssLoaderOptions,
                      modules: false,
                    },
                    sideEffects: true,
                  },
                  {
                    loader: 'yoshi-style-dependencies/css-loader',
                    options: cssLoaderOptions,
                  },
                ],
              },
              {
                loader: 'yoshi-style-dependencies/postcss-loader',
                options: {
                  // https://github.com/facebookincubator/create-react-app/issues/2677
                  ident: 'postcss',
                  plugins: [
                    experimentalRtlCss && require('postcss-rtl')(),
                    require('autoprefixer')({
                      overrideBrowserslist: [
                        '> 0.5%',
                        'last 2 versions',
                        'Firefox ESR',
                        'not dead',
                        'ie >= 11',
                      ].join(','),
                      flexbox: 'no-2009',
                    }),
                  ].filter(Boolean),
                  sourceMap: isDev,
                },
              },

              {
                loader: 'yoshi-style-dependencies/resolve-url-loader',
              },
            ]
          : [
              {
                loader: 'yoshi-style-dependencies/css-loader',
                options: {
                  ...cssLoaderOptions,
                  importLoaders: 2 + Number(tpaStyle),
                  exportOnlyLocals: true,
                  sourceMap: false,
                },
              },
            ]),

        ...(tpaStyle ? [{ loader: 'wix-tpa-style-loader' }] : []),

        {
          test: /\.less$/,
          loader: 'less-loader',
          options: {
            sourceMap: embedCss,
            paths: ['.', 'node_modules'],
          },
        },

        {
          test: /\.(scss|sass)$/,
          loader: 'yoshi-style-dependencies/sass-loader',
          options: {
            sourceMap: embedCss,
            implementation: importCwd.silent(
              'yoshi-style-dependencies/node-sass',
            ),
            includePaths: sassIncludePaths,
          },
        },
      ],
    },

    // Experimental Stylable loader
    ...(process.env.EXPERIMENTAL_STYLABLE_LOADER
      ? [
          {
            test: /\.st\.css$/i,
            use: [
              ...(embedCss
                ? [
                    // expected to be installed on the project that tests this experimental feature
                    // eslint-disable-next-line import/no-extraneous-dependencies
                    require('@stylable/experimental-loader').stylableLoaders.runtime(),
                    {
                      loader: MiniCssExtractPlugin.loader,
                      options: { reloadAll: true },
                    },
                    // expected to be installed on the project that tests this experimental feature
                    // eslint-disable-next-line import/no-extraneous-dependencies
                    require('@stylable/experimental-loader').stylableLoaders.transform(),
                  ]
                : // https://github.com/wix/stylable/tree/master/packages/experimental-loader#ssr-exportsonly
                  [
                    // expected to be installed on the project that tests this experimental feature
                    // eslint-disable-next-line import/no-extraneous-dependencies
                    require('@stylable/experimental-loader').stylableLoaders.transform(
                      { exportsOnly: true },
                    ),
                  ]),
            ],
          },
        ]
      : []),
  ];
};

export function createBaseWebpackConfig({
  configName,
  name,
  target,
  isDev = false,
  isHot = false,
  useTypeScript = false,
  typeCheckTypeScript = false,
  useAngular = false,
  separateCss = false,
  keepFunctionNames = false,
  suricate = false,
  isMonorepo = false,
  separateStylableCss = false,
  experimentalRtlCss = false,
  cssModules = true,
  cwd = process.cwd(),
  devServerUrl,
  externalizeRelativeLodash = false,
  isAnalyze = false,
  createEjsTemplates = false,
  performanceBudget,
  includeStyleLoaders = true,
  includeInTranspilation = shouldTranspileFile,
  enhancedTpaStyle = false,
  tpaStyle = false,
  forceEmitSourceMaps = false,
  exportAsLibraryName,
  nodeExternalsWhitelist = [],
  useAssetRelocator = false,
  useYoshiServer = false,
  useProgressBar = true,
  createWorkerManifest = true,
  useCustomSourceMapPlugin = false,
  forceEmitStats = false,
  forceMinimizeServer = false,
  useAbsoluteUrlsForCssAssets = false,
  serverExternals,
  umdNamedDefine = false,
  transpileCarmiOutput = false,
  disableEmitSourceMaps = false,
  overrideDefinePluginBrowserEnvVar,
}: {
  name: string;
  configName:
    | 'client'
    | 'server'
    | 'web-worker'
    | 'site-assets'
    | 'web-worker-server';
  target: CompilationTarget;
  isDev?: boolean;
  isHot?: boolean;
  useTypeScript?: boolean;
  typeCheckTypeScript?: boolean;
  useAngular?: boolean;
  separateCss?: boolean;
  keepFunctionNames?: boolean;
  suricate?: boolean;
  isMonorepo?: boolean;
  separateStylableCss?: boolean;
  experimentalRtlCss?: boolean;
  cssModules?: boolean;
  cwd?: string;
  includeInTranspilation?: Array<RuleSetCondition> | RuleSetCondition;
  devServerUrl: string;
  externalizeRelativeLodash?: boolean;
  isAnalyze?: boolean;
  createEjsTemplates?: boolean;
  performanceBudget?: webpack.PerformanceOptions;
  includeStyleLoaders?: boolean;
  enhancedTpaStyle?: boolean;
  tpaStyle?: boolean;
  forceEmitSourceMaps?: boolean;
  exportAsLibraryName?: string;
  nodeExternalsWhitelist?: Array<RegExp>;
  useAssetRelocator?: boolean;
  useYoshiServer?: boolean;
  useProgressBar?: boolean;
  createWorkerManifest?: boolean;
  // changes source map to include public path and
  // use plugin directly instead of "devtool" option
  useCustomSourceMapPlugin?: boolean;
  forceEmitStats?: boolean;
  forceMinimizeServer?: boolean;
  useAbsoluteUrlsForCssAssets?: boolean;
  serverExternals?: ExternalsElement | Array<ExternalsElement>;
  umdNamedDefine?: boolean;
  transpileCarmiOutput?: boolean;
  overrideDefinePluginBrowserEnvVar?: boolean;
  disableEmitSourceMaps?: boolean;
}): webpack.Configuration {
  const join = (...dirs: Array<string>) => path.join(cwd, ...dirs);

  const styleLoaders = getStyleLoaders({
    name,
    embedCss: target !== 'node',
    cssModules,
    isDev,
    isHot,
    experimentalRtlCss,
    separateCss,
    tpaStyle,
    useAbsoluteUrlsForCssAssets,
  });

  const publicPath = calculatePublicPath({
    suricate,
    appName: name,
    devServerUrl,
    // https://github.com/wix/yoshi/pull/1803
    useUnversionedBaseUrl: createEjsTemplates && !isDev,
  });

  const babelConfig = createBabelConfig({
    modules: false,
    targets: target === 'node' ? 'current node' : undefined,
  });

  const notExternalModules: Array<RegExp> = [
    reStyle,
    reAssets,
    /node_modules\/bootstrap-hot-loader/,
    ...nodeExternalsWhitelist,
  ];

  const isBrowser = process.env.BROWSER !== 'none';
  // We can take value from env variable mostly for internal purposes and not opening this option to be 'public'
  // 'auto' should satisfy all user's needs. It will auto generate available port and use it.
  const analyzerPort = customAnalyzerPort || (isBrowser ? 'auto' : undefined);

  const terserOptions = {
    parallel: true,
    cache: true,
    sourceMap: true,
    terserOptions: {
      output: {
        ascii_only: true,
      },
      keep_fnames: keepFunctionNames,
    },
  };

  const artifactVersion = inTeamCity
    ? getProjectArtifactVersion(name)
    : '0.0.0';

  const config: webpack.Configuration = {
    context: join(SRC_DIR),

    name: configName,

    mode: isProduction ? 'production' : 'development',

    output: {
      path: join(STATICS_DIR),
      publicPath,
      pathinfo: isDev,
      filename: isDev
        ? '[name].bundle.js'
        : createEjsTemplates
        ? '[name].[contenthash:8].bundle.min.js'
        : '[name].bundle.min.js',
      chunkFilename: isDev
        ? '[name].chunk.js'
        : createEjsTemplates
        ? '[name].[contenthash:8].chunk.min.js'
        : '[name].chunk.min.js',
      hotUpdateMainFilename: 'updates/[hash].hot-update.json',
      hotUpdateChunkFilename: 'updates/[id].[hash].hot-update.js',

      ...(exportAsLibraryName
        ? {
            library: exportAsLibraryName,
            libraryTarget: 'umd',
            umdNamedDefine,
            globalObject: "(typeof self !== 'undefined' ? self : this)",
          }
        : {}),

      ...(target === 'node'
        ? {
            path: join(
              process.env.EXPERIMENTAL_YOSHI_SERVERLESS
                ? SERVERLESS_SCOPE_BUILD_DIR(getServerlessScope(name))
                : BUILD_DIR,
            ),
            filename: '[name].js',
            chunkFilename: `${SERVER_CHUNKS_DIR}/[name].js`,
            libraryTarget: 'umd',
            umdNamedDefine,
            globalObject: "(typeof self !== 'undefined' ? self : this)",
            // Point sourcemap entries to original disk location (format as URL on Windows)
            // todo: remove once useCustomSourceMapPlugin option is getting merged
            devtoolModuleFilenameTemplate: (info) =>
              path.resolve(info.absoluteResourcePath).replace(/\\/g, '/'),
          }
        : {}),

      // https://github.com/wix/yoshi/pull/497
      jsonpFunction: `webpackJsonp_${toIdentifier(name)}`,

      // @ts-ignore Not available in @types/webpack
      // https://webpack.js.org/configuration/output/#outputchunkcallbackname
      chunkCallbackName: `webpackWorker_${toIdentifier(name)}`,
    },

    resolve: {
      modules: ['node_modules', join(SRC_DIR)],
      extensions: ['.mjs', '.js', '.jsx', '.ts', '.tsx', '.svelte', '.json'],
      mainFields: [
        'svelte',
        ...(target === 'node' ? [] : ['browser']),
        'module',
        'main',
      ],
    },

    resolveLoader: {
      modules: [
        // Search in `yoshi-common`'s node_modules first
        path.join(__dirname, '../node_modules'),

        path.join(__dirname, '../../../node_modules'),

        // Normal node module resolution
        // https://webpack.js.org/configuration/resolve/#resolvemodules
        'node_modules',
      ],
    },

    optimization:
      target !== 'node'
        ? {
            minimize: !isDev,
            concatenateModules: isProduction && !disableModuleConcat,
            minimizer: [
              new TerserPlugin(terserOptions),
              new OptimizeCSSAssetsPlugin({
                cssProcessor: cssnano,
                cssProcessorPluginOptions: {
                  preset: [
                    'default',
                    {
                      // These bugs prevents us from using mergeLonghand plugin:
                      // https://github.com/cssnano/cssnano/issues/675
                      // https://github.com/cssnano/cssnano/issues/847
                      mergeLonghand: false,
                    },
                  ],
                },
              }),
            ],

            ...(createEjsTemplates && target === 'web'
              ? {
                  runtimeChunk: {
                    name: 'webpack-runtime',
                  },
                }
              : {}),

            splitChunks: false,
          }
        : {
            // Do not modify/set the value of `process.env.NODE_ENV`
            nodeEnv: false,
            // Faster build time and possibly easier debugging
            minimize: forceMinimizeServer,
            minimizer: [new TerserPlugin(terserOptions)],
          },

    plugins: [
      new ModuleNotFoundPlugin(cwd),
      new CaseSensitivePathsPlugin(),

      ...(useTypeScript &&
      typeCheckTypeScript &&
      isDev &&
      configName === 'client'
        ? [
            new (require('fork-ts-checker-webpack-plugin'))({
              tsconfig: join(TSCONFIG_FILE),
              async: false,
              silent: true,
              checkSyntacticErrors: true,
              formatter: require('react-dev-utils/typescriptFormatter'),
            }),
          ]
        : []),

      ...(isHot ? [new webpack.HotModuleReplacementPlugin()] : []),

      ...(target === 'web' && createEjsTemplates
        ? [
            new HtmlRenderingDataPlugin({
              outputFileName: isDev
                ? 'html-rendering-data.json'
                : 'html-rendering-data.min.json',
            }),
          ]
        : []),

      ...(target === 'web'
        ? [
            ...(createEjsTemplates && fs.pathExistsSync(join(TEMPLATES_DIR))
              ? [
                  ...globby
                    .sync('**/*.+(ejs|vm)', {
                      cwd: join(TEMPLATES_DIR),
                      absolute: true,
                    })
                    .map((templatePath) => {
                      const basename = path.basename(templatePath);
                      const filename = join(TEMPLATES_BUILD_DIR, basename);
                      const customLoader = require.resolve(
                        './lodash-template-loader',
                      );

                      return new HtmlWebpackPlugin({
                        filename: isDev
                          ? filename
                          : prependNameWith(filename, 'min'),
                        template: `${customLoader}!${templatePath}`,
                        minify: false,
                        inject: false,
                        templateParameters: (
                          compilation,
                          assets,
                          assetTags,
                          options,
                        ) => {
                          // Add `async` attribute to all non-inline scripts
                          assetTags.bodyTags.forEach((tag) => {
                            if (
                              tag.tagName === 'script' &&
                              tag.attributes.src
                            ) {
                              tag.attributes.async = '';
                            }
                          });

                          // Values available for injection in EJS template
                          return {
                            compilation,
                            webpackConfig: compilation.options,
                            tags: {
                              css: assetTags.headTags,
                              js: assetTags.bodyTags,
                            },
                            files: assets,
                            options,
                          };
                        },
                      });
                    }),

                  new InlineChunkHtmlPlugin(HtmlWebpackPlugin, [
                    /\.css|\.inline|webpack-runtime/,
                  ]),

                  new InterpolateHtmlPlugin(HtmlWebpackPlugin, {
                    PUBLIC_PATH: publicPath,
                  }),
                ]
              : []),

            ...(fs.pathExistsSync(PUBLIC_DIR)
              ? [
                  new CopyPlugin([
                    { from: join(PUBLIC_DIR), to: join(ASSETS_DIR) },
                  ]),
                ]
              : []),

            new webpack.LoaderOptionsPlugin({
              minimize: !isDev,
            }),

            ...(separateCss
              ? [
                  new MiniCssExtractPlugin({
                    filename: isDev
                      ? '[name].css'
                      : createEjsTemplates
                      ? '[name].[contenthash:8].min.css'
                      : '[name].min.css',
                    chunkFilename: isDev
                      ? '[name].chunk.css'
                      : createEjsTemplates
                      ? '[name].[contenthash:8].chunk.min.css'
                      : '[name].chunk.min.css',
                  }),

                  ...(enhancedTpaStyle
                    ? [
                        // @ts-ignore
                        new TpaStyleWebpackPlugin(),
                      ]
                    : []),

                  ...(!createEjsTemplates && !experimentalRtlCss
                    ? [
                        new RtlCssPlugin(
                          isDev ? '[name].rtl.css' : '[name].rtl.min.css',
                        ),
                      ]
                    : []),
                ]
              : []),

            new webpack.IgnorePlugin(/^\.\/locale$/, /moment$/),

            ...(process.env.EXPERIMENTAL_STYLABLE_LOADER
              ? []
              : [
                  new StylableWebpackPlugin({
                    ...getCommonStylbleWebpackConfig(name),
                    filename: isDev
                      ? '[name].stylable.bundle.css'
                      : createEjsTemplates
                      ? '[name].[hash:8].stylable.bundle.css'
                      : '[name].stylable.bundle.css',
                    outputCSS: separateStylableCss,
                    includeCSSInJS: !separateStylableCss,
                    runtimeMode: 'shared',
                    globalRuntimeId,
                  }),
                ]),

            // site-assets manifest is handled with its own plugin
            ...(configName !== 'site-assets'
              ? [new ManifestPlugin({ fileName: 'manifest', isDev })]
              : []),
          ]
        : []),

      ...(createWorkerManifest &&
      (target === 'webworker' || target === 'async-webworker')
        ? [new ManifestPlugin({ fileName: 'manifest-worker', isDev })]
        : []),

      new webpack.DefinePlugin({
        ...(target !== 'node'
          ? {
              'process.env.NODE_ENV': JSON.stringify(
                isProduction ? 'production' : 'development',
              ),
              'process.env.IS_MINIFIED': isDev ? 'false' : 'true',
              'window.__CI_APP_VERSION__': JSON.stringify(artifactVersion),
              'process.env.ARTIFACT_ID': JSON.stringify(getProjectArtifactId()),
            }
          : {}),
        ...(useYoshiServer && process.env.EXPERIMENTAL_YOSHI_SERVERLESS
          ? {
              'process.env.YOSHI_SERVERLESS_BASE': JSON.stringify(
                getServerlessBase(getServerlessScope(name)),
              ),
            }
          : {}),
        'process.env.PACKAGE_NAME': JSON.stringify(stripOrganization(name)),
        'process.env.browser': JSON.stringify(
          typeof overrideDefinePluginBrowserEnvVar !== 'undefined'
            ? overrideDefinePluginBrowserEnvVar
            : target !== 'node',
        ),
      }),

      ...(target === 'node'
        ? [
            new ExportDefaultPlugin(),

            new webpack.BannerPlugin({
              banner: fs.readFileSync(
                path.join(__dirname, 'utils/source-map-support.js'),
                'utf-8',
              ),
              raw: true,
              entryOnly: false,
            }),
            ...(process.env.EXPERIMENTAL_STYLABLE_LOADER
              ? []
              : [
                  new StylableWebpackPlugin({
                    ...getCommonStylbleWebpackConfig(name),
                    outputCSS: false,
                    includeCSSInJS: false,
                  }),
                ]),
          ]
        : []),

      ...(isAnalyze
        ? [
            new BundleAnalyzerPlugin({
              openAnalyzer: isBrowser,
              analyzerPort,
            }),
          ]
        : []),

      ...(forceEmitStats ||
      (inTeamCity && isProduction && !isDev && !disableStatsOutput)
        ? [
            new StatsWriterPlugin({
              // The plugin does not accept absolute path, so we have to navigate relatively from bundle location
              // /dist/statics to stats file /target/webpack-stats.json
              filename: path.join(
                '../../',
                configName === 'client'
                  ? STATS_FILE
                  : addExtensionPrefix(STATS_FILE, configName),
              ),
              stats: {
                all: true,
                source: false,
                chunkModules: false,
                chunkRootModules: false,
                maxModules: Infinity,
              },
            }),
          ]
        : []),
      ...(useCustomSourceMapPlugin
        ? target === 'node'
          ? [sourceMapPlugin({ inline: true, showPathOnDisk: true })]
          : inTeamCity || forceEmitSourceMaps
          ? [sourceMapPlugin({ publicPath })]
          : !isProduction
          ? [
              sourceMapPlugin({
                cheap: true,
                moduleMaps: true,
                evaluate: true,
              }),
            ]
          : []
        : []),

      ...(!process.env.DEBUG && useProgressBar
        ? [
            new WebpackBar(
              getProgressBarInfo(configName, isDev, isMonorepo, name, target),
            ),
          ]
        : []),
    ],

    devtool:
      disableEmitSourceMaps || useCustomSourceMapPlugin
        ? false
        : target !== 'node'
        ? inTeamCity || forceEmitSourceMaps
          ? 'source-map'
          : !isProduction
          ? 'cheap-module-eval-source-map'
          : false
        : 'inline-source-map',

    module: {
      // Makes missing exports an error instead of warning
      strictExportPresence: true,

      // carmi returns a big blob of code which doesn't contain "require"/"import"
      // calls for other files and therefore don't need to be parsed by webpack
      // this improves the build time for Thunderbolt
      // https://webpack.js.org/configuration/module/#modulenoparse
      noParse: /\.carmi.(js|ts)$/,

      rules: [
        ...(useAssetRelocator && target === 'node'
          ? [
              {
                test: /\.(js|ts|tsx)$/,
                parser: { amd: false },
                use: {
                  loader: '@zeit/webpack-asset-relocator-loader',
                  options: {
                    outputAssetBase: 'assets',
                    existingAssetNames: [],
                    wrapperCompatibility: true,
                    escapeNonAnalyzableRequires: true,
                  },
                },
              },
            ]
          : []),

        ...(includeStyleLoaders ? styleLoaders : []),

        ...(externalizeRelativeLodash
          ? [
              {
                test: /[\\/]node_modules[\\/]lodash[\\/]\w+/,
                loader: 'externalize-relative-module-loader',
              },
            ]
          : []),

        {
          test: /\.(svelte|svx)$/,
          // Both, `svelte-loader` and `svelte-preprocess-sass` should be installed
          // by the project that needs it.
          //
          // If more users use `svelte` we'll consider adding it to everyone by default.
          loader: 'svelte-loader',
          options: {
            immutable: true,
            hydratable: true,
            // https://github.com/sveltejs/svelte-loader/issues/67
            onwarn: (warning: any, onwarn: any) => {
              warning.code === 'css-unused-selector' || onwarn(warning);
            },
            preprocess: [
              {
                style:
                  importCwd.silent('svelte-preprocess-sass') &&
                  (importCwd.silent('svelte-preprocess-sass') as any).sass({
                    includePaths: sassIncludePaths,
                  }),
              },
              mdsvex({
                extension: '.svx',
              }),
              ...(target === 'node'
                ? [
                    SveltePreprocessSSR({
                      packageName: name,
                      cwd,
                    }),
                  ]
                : []),
            ],
            dev: isDev,
            emitCss: target !== 'node',
            generate: target === 'node' ? 'ssr' : 'dom',
          },
        },

        ...(useYoshiServer
          ? [
              {
                test: /\.api\.(js|ts)$/,
                // The loader shouldn't be applied to entry files, only to files that
                // are imported by other files and passed to `yoshi-server/client`
                ...(target === 'node'
                  ? {
                      issuer: () => true,
                    }
                  : {}),
                loader: require.resolve('yoshi-server-tools/build/loader'),
              },
            ]
          : []),

        ...(useAngular
          ? [
              {
                test: reScript,
                loader: 'yoshi-angular-dependencies/ng-annotate-loader',
                include: shouldTranspileFile,
              },
            ]
          : []),

        {
          test: /\.inline\.worker\.(js|tsx?)$/,
          use: [
            {
              loader: 'worker-loader',
              options: {
                inline: true,
              },
            },
          ],
        },

        {
          test: /\.(ts|tsx)$/,
          // Don't transpile the output of Carmi with Babel/TypeScript
          // https://github.com/wix/yoshi/pull/2227
          exclude: /\.carmi.(js|ts)$/,
          include: includeInTranspilation,
          use: [
            {
              loader: 'thread-loader',
              options: {
                workers: os.cpus().length - 1,
              },
            },

            ...(useAngular
              ? [{ loader: 'yoshi-angular-dependencies/ng-annotate-loader' }]
              : []),

            process.env.EXPERIMENTAL_BABEL_LOADER
              ? {
                  loader: 'babel-loader',
                  options: {
                    ...babelConfig,
                    presets: [
                      ...babelConfig.presets,
                      require.resolve('@babel/preset-typescript'),
                    ],
                    cacheDirectory: true,
                    // https://github.com/facebook/create-react-app/issues/6846
                    cacheCompression: false,
                    compact: isProduction,
                    cacheIdentifier: getCacheIdentifier(
                      // Use different cache key for build/start
                      isProduction ? 'production' : 'development',
                      // Cache key should include these packages and their versions
                      [
                        'babel-preset-yoshi',
                        'yoshi-common',
                        '@babel/preset-typescript',
                      ],
                    ),
                  },
                }
              : {
                  loader: 'ts-loader',
                  options: {
                    happyPackMode: true,
                    compilerOptions: useAngular
                      ? {}
                      : {
                          module: 'esnext',
                          moduleResolution: 'node',
                          ...(process.env.NODE_ENV === 'development'
                            ? {
                                lib: ['es2017'],
                                target: 'es2017',
                              }
                            : {}),
                        },
                  },
                },
          ],
        },

        {
          test: reScript,
          include: includeInTranspilation,
          // Optimize JS processing worker stuff excluded due to
          // https://github.com/webpack-contrib/worker-loader/issues/177
          exclude: [/\.inline\.worker\.js/, /\.carmi.(js|ts)$/],
          use: [
            {
              loader: 'thread-loader',
              options: {
                workers: os.cpus().length - 1,
              },
            },
          ],
        },

        ...(transpileCarmiOutput
          ? [
              {
                test: /\.carmi.(js|ts)$/,
                include: includeInTranspilation,
                use: [
                  {
                    loader: 'babel-loader',
                    options: {
                      ...babelConfig,
                      // Carmi files are quite big and this option
                      // prevents from a warning to be showing during the build
                      // https://babeljs.io/docs/en/options#compact
                      compact: true,
                      sourceMaps: false,
                    },
                  },
                ],
              },
            ]
          : []),
        {
          test: reScript,
          // Don't transpile the output of Carmi with Babel/TypeScript
          // https://github.com/wix/yoshi/pull/2227
          exclude: /\.carmi.js$/,
          include: includeInTranspilation,
          use: [
            {
              loader: 'babel-loader',
              options: {
                ...babelConfig,
              },
            },
          ],
        },

        {
          oneOf: [
            {
              test: /\.inline\.svg$/,
              loader: 'svg-inline-loader',
            },

            {
              test: /\.svg$/,
              issuer: {
                test: /\.(j|t)sx?$/,
              },
              use: [
                {
                  loader: '@svgr/webpack',
                  options: {
                    svgoConfig: {
                      plugins: {
                        removeViewBox: false,
                      },
                    },
                  },
                },
                {
                  loader: 'svg-url-loader',
                  options: {
                    iesafe: true,
                    noquotes: true,
                    limit: 10000,
                    name: staticAssetName,
                  },
                },
              ],
            },
            {
              test: /\.svg$/,
              use: [
                {
                  loader: 'svg-url-loader',
                  options: {
                    iesafe: true,
                    limit: 10000,
                    name: staticAssetName,
                  },
                },
              ],
            },

            {
              test: /\.carmi.(js|ts)$/,
              exclude: /node_modules/,
              // Not installed by Yoshi and should be installed by the project that needs it.
              loader: 'carmi/loader',
            },

            {
              test: /\.md$/,
              loader: 'raw-loader',
            },

            {
              test: /\.haml$/,
              loader: 'ruby-haml-loader',
            },

            {
              test: /\.html$/,
              loader: 'html-loader',
            },

            {
              test: /\.(graphql|gql)$/,
              loader: 'graphql-tag/loader',
            },

            {
              test: reAssets,
              loader: 'url-loader',
              options: {
                name: staticAssetName,
                limit: 10000,
                emitFile: target !== 'node',
              },
            },
          ],
        },
      ],
    },

    stats: 'none',

    node:
      target !== 'node'
        ? {
            fs: 'empty',
            net: 'empty',
            tls: 'empty',
            __dirname: true,
          }
        : {
            console: false,
            global: false,
            process: false,
            Buffer: false,
            __filename: false,
            __dirname: false,
          },

    ...(target === 'node'
      ? {
          externals: serverExternals || [
            (
              context,
              request,
              callback: (error?: any, result?: any) => void,
            ) => {
              let res: string;
              try {
                res = resolve.sync(request, { basedir: `${context}/` });
              } catch (err) {
                // If the request cannot be resolved, we need to tell webpack to
                // "bundle" it so that webpack shows an error (that it cannot be
                // resolved).
                return callback();
              }

              // Same as above, if the request cannot be resolved we need to have
              // webpack "bundle" it so it surfaces the not found error.
              if (!res) {
                return callback();
              }

              // Webpack itself has to be compiled because it doesn't always use module relative paths
              if (
                res.match(/node_modules[/\\]webpack/) ||
                res.match(/node_modules[/\\]css-loader/)
              ) {
                return callback();
              }

              // Bundle any white listed dependencies
              if (notExternalModules.some((regex) => regex.test(res))) {
                return callback();
              }

              // Everything in Yoshi Serverless (but ambassador deps) should be bundled
              if (useYoshiServer && process.env.EXPERIMENTAL_YOSHI_SERVERLESS) {
                // Ambassador RPC modules should be externals
                const ambassadorRegex = /@wix\/ambassador-.+\/rpc/;
                if (ambassadorRegex.test(res)) {
                  return callback(undefined, `commonjs ${request}`);
                }
                return callback();
              }

              // Anything else that is within `node_modules` is externalized.
              if (res.match(/node_modules/)) {
                return callback(undefined, `commonjs ${request}`);
              }

              // Default behavior: bundle the code!
              callback();
            },
          ],
        }
      : {}),

    ...(target === 'web'
      ? {
          performance: {
            ...(isProduction
              ? performanceBudget || { hints: false }
              : {
                  hints: false,
                }),
          },
        }
      : {}),
  };

  config.target =
    target === 'async-webworker' ? asyncWebWorkerTarget(config) : target;

  return config;
}
