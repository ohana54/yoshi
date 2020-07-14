import path from 'path';
import fs from 'fs-extra';
import chalk from 'chalk';
import resolve from 'resolve';
import webpack from 'webpack';
import globby from 'globby';
import formatWebpackMessages from 'react-dev-utils/formatWebpackMessages';
import Watchpack from 'watchpack';
import { shouldDeployToCDN, inTeamCity } from 'yoshi-helpers/build/queries';
import { getProjectCDNBasePath } from 'yoshi-helpers/utils';
import { SRC_DIR, ROUTES_DIR } from 'yoshi-config/build/paths';
import { isTruthy } from './utils/helpers';
import { getDevServerUrl } from './utils/suricate';

const isDevelopment = process.env.NODE_ENV === 'development';

const possibleServerEntries = ['./server', '../dev/server'];

function createCompiler(webpackConfig: Array<webpack.Configuration>) {
  let compiler: webpack.MultiCompiler;

  try {
    compiler = webpack(webpackConfig);
  } catch (err) {
    console.log(chalk.red('Failed to compile.'));
    console.log();
    console.log(err.message || err);
    console.log();

    return process.exit(1);
  }

  return compiler;
}

function addEntry(
  entry: string | Array<string> | webpack.Entry | webpack.EntryFunc,
  hotEntries: Array<string>,
): string | Array<string> | webpack.Entry | webpack.EntryFunc {
  let newEntry: string | Array<string> | webpack.Entry | webpack.EntryFunc = {};

  if (typeof entry === 'function') {
    const originalEntry = entry;

    // @ts-ignore
    newEntry = async () => {
      return addEntry(await originalEntry(), hotEntries);
    };
  } else if (!Array.isArray(entry) && typeof entry === 'object') {
    const keys = Object.keys(entry);

    for (const entryName of keys) {
      newEntry[entryName] = hotEntries.concat(entry[entryName]);
    }
  } else {
    newEntry = hotEntries.concat(entry);
  }

  return newEntry;
}

function overrideRules(
  rules: Array<webpack.Rule>,
  patch: (rule: webpack.Rule) => webpack.Rule,
): Array<webpack.Rule> {
  return rules.map((ruleToPatch) => {
    let rule = patch(ruleToPatch);
    if (rule.rules) {
      rule = { ...rule, rules: overrideRules(rule.rules, patch) };
    }
    if (rule.oneOf) {
      rule = { ...rule, oneOf: overrideRules(rule.oneOf, patch) };
    }
    if (rule.use) {
      // @ts-ignore
      rule = { ...rule, use: overrideRules(rule.use, patch) };
    }
    return rule;
  });
}

function waitForCompilation(compiler: webpack.Compiler) {
  return new Promise((resolve, reject) => {
    compiler.hooks.done.tap('promise', (stats) =>
      stats.hasErrors() ? reject(stats) : resolve(stats),
    );
  });
}

function createServerEntries(context: string, cwd: string = process.cwd()) {
  const serverFunctions = fs.pathExistsSync(path.join(cwd, SRC_DIR))
    ? globby.sync('**/*.api.(js|ts)', {
        cwd: path.join(cwd, SRC_DIR),
        absolute: true,
      })
    : [];

  const serverRoutes = fs.pathExistsSync(path.join(cwd, ROUTES_DIR))
    ? globby.sync('**/*.(js|ts)', {
        cwd: path.join(cwd, ROUTES_DIR),
        absolute: true,
      })
    : [];

  let initServerPath;
  try {
    initServerPath = resolve.sync(path.join(cwd, SRC_DIR, 'init-server'), {
      extensions: ['.js', '.ts'],
    });
  } catch (e) {
    // No 'init-server' file, Do nothing
  }

  // Normalize to an object with short entry names
  const entries: Record<string, string> = [
    ...serverFunctions,
    ...serverRoutes,
    ...(initServerPath ? [initServerPath] : []),
  ].reduce((acc, filepath) => {
    return {
      ...acc,
      [path.relative(context, filepath).replace(/\.[^/.]+$/, '')]: filepath,
    };
  }, {});

  // Add custom entries for `yoshi-server`
  const yoshiServerEntry = process.env.EXPERIMENTAL_YOSHI_SERVERLESS
    ? `yoshi-serverless/build/routes/api`
    : `yoshi-server/build/routes/api`;

  if (process.env.EXPERIMENTAL_YOSHI_SERVERLESS) {
    entries['../serverless'] =
      'yoshi-common/build/templates/serverless/serverless.js';
  }

  entries['routes/_api_'] = yoshiServerEntry;

  if (isDevelopment) {
    entries['routes/_launchEditor_'] = process.env.EXPERIMENTAL_YOSHI_SERVERLESS
      ? 'yoshi-serverless/build/routes/launchEditor'
      : 'yoshi-server/build/routes/launchEditor';
  }

  return entries;
}

function watchDynamicEntries(
  watching: webpack.Watching,
  cwd: string = process.cwd(),
) {
  const wp = new Watchpack({});

  wp.on('aggregated', () => {
    watching.invalidate();
  });

  wp.watch([], [path.join(cwd, SRC_DIR), path.join(cwd, ROUTES_DIR)]);
}

function validateServerEntry({
  cwd = process.cwd(),
  extensions,
  yoshiServer = false,
}: {
  cwd?: string;
  extensions: Array<string>;
  yoshiServer: boolean;
}) {
  const serverEntry = possibleServerEntries.find((entry) => {
    return (
      globby.sync(`${entry}(${extensions.join('|')})`, {
        cwd: path.join(cwd, SRC_DIR),
      }).length > 0
    );
  });

  if (!serverEntry && !yoshiServer) {
    throw new Error(
      `We couldn't find your server entry. Please use one of the defaults:
      - "src/server": for a fullstack project
      - "dev/server": for a client only project`,
    );
  }

  return serverEntry;
}

function calculatePublicPath({
  suricate,
  appName,
  devServerUrl,
  useUnversionedBaseUrl,
}: {
  devServerUrl: string;
  suricate: boolean;
  appName: string;
  useUnversionedBaseUrl: boolean;
}) {
  if (process.env.YOSHI_PUBLIC_PATH) {
    return process.env.YOSHI_PUBLIC_PATH;
  }

  // default public path
  let publicPath = '/';

  if (!inTeamCity() || isDevelopment) {
    // When on local machine or on dev environment,

    if (suricate) {
      publicPath = getDevServerUrl(appName);
    } else {
      // set the local dev-server url as the public path
      publicPath = devServerUrl;
    }
  }

  // In case we are running in CI and there is a pom.xml file, change the public path according to the path on the cdn
  // The path is created using artifactName from pom.xml and artifact version from an environment param.
  if (shouldDeployToCDN(appName)) {
    publicPath = getProjectCDNBasePath(appName, useUnversionedBaseUrl);
  }

  return publicPath;
}

async function runWebpack(
  configs: Array<webpack.Configuration | undefined>,
  // @ts-ignore
): Promise<webpack.compilation.MultiStats> {
  try {
    const compiler = createCompiler(configs.filter(isTruthy));

    const webpackStats: webpack.compilation.MultiStats = await new Promise(
      (resolve, reject) => {
        // @ts-ignore
        compiler.run((err, stats) => (err ? reject(err) : resolve(stats)));
      },
    );

    // @ts-ignore
    const messages = formatWebpackMessages(webpackStats.toJson({}, true));

    if (messages.errors.length) {
      // Error handled by webpack
      console.log(chalk.red('Failed to compile.\n'));
      console.error(messages.errors.join('\n\n'));

      const fullLog = webpackStats.stats
        .filter((s) => s.hasErrors())
        .map((s) => s.toString())
        .join('\n\n');
      await fs.writeFile('./target/yoshi-error.log', fullLog);
      console.error('Full log written to ./target/yoshi-error.log\n\n');

      process.exit(1);
    }

    if (messages.warnings.length) {
      console.log(chalk.yellow('Compiled with warnings.\n'));
      console.log(messages.warnings.join('\n\n'));
    } else {
      console.log(chalk.green('Compiled successfully.\n'));
    }

    return webpackStats;
  } catch (error) {
    // Error webpack couldn't handle
    console.log(chalk.red('Failed to compile.\n'));
    console.error(error);

    process.exit(1);
  }
}

export {
  runWebpack,
  createCompiler,
  waitForCompilation,
  addEntry,
  overrideRules,
  createServerEntries,
  watchDynamicEntries,
  validateServerEntry,
  calculatePublicPath,
};
