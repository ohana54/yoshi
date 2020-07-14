import path from 'path';
import childProcess, { ChildProcess } from 'child_process';
import fs from 'fs-extra';
import mkdirp from 'mkdirp';
import chokidar from 'chokidar';
import chalk from 'chalk';
import psTree from 'ps-tree';
import detect from 'detect-port';
import config from 'yoshi-config';
import { POM_FILE } from 'yoshi-config/build/paths';
import xmldoc from 'xmldoc';
// eslint-disable-next-line import/no-extraneous-dependencies
import { Stats } from 'webpack';
import { inTeamCity, getBuildInfo } from './queries';

export function logIfAny(log: any) {
  if (log) {
    console.log(log);
  }
}

export const suffix = (ending: string) => (str: string) => {
  const hasSuffix = str.lastIndexOf(ending) === str.length - ending.length;
  return hasSuffix ? str : str + ending;
};

export const reportWebpackStats = (
  buildType: 'debug' | 'production',
  stats: Stats,
) => {
  console.log(chalk.magenta(`Webpack summary for ${buildType} build:`));
  logIfAny(
    stats.toString({
      colors: true,
      hash: false,
      chunks: false,
      assets: true,
      children: false,
      version: false,
      timings: false,
      modules: false,
      entrypoints: false,
      warningsFilter: /export .* was not found in/,
      builtAt: false,
    }),
  );
};

export const writeFile = (targetFileName: string, data: string) => {
  mkdirp.sync(path.dirname(targetFileName));
  fs.writeFileSync(path.resolve(targetFileName), data);
};

type callback = (path: string) => void;

export const watch = (
  {
    pattern,
    cwd = process.cwd(),
    ignoreInitial = true,
    ...options
  }: { pattern: string | Array<string>; cwd: string; ignoreInitial?: boolean },
  callback: callback,
) => {
  const watcher = chokidar
    .watch(pattern, { cwd, ignoreInitial, ...options })
    .on('all', (event, filePath) => callback(filePath));

  return watcher;
};

export const getMochaReporter = () => {
  if (inTeamCity()) {
    return 'mocha-teamcity-reporter';
  }

  if (process.env.mocha_reporter) {
    return process.env.mocha_reporter;
  }

  return 'progress';
};

export const getListOfEntries = (entry: any) => {
  if (typeof entry === 'string') {
    return [path.resolve('src', entry)];
  } else if (typeof entry === 'object') {
    return Object.keys(entry).map((name) => {
      const file = entry[name];
      return path.resolve('src', file);
    });
  }
  return [];
};

export const shouldTransformHMRRuntime = () => {
  return config.hmr === 'auto' && config.isReactProject;
};

export const getProcessIdOnPort = (port: number) => {
  return childProcess
    .execSync(`lsof -i:${port} -P -t -sTCP:LISTEN`, { encoding: 'utf-8' })
    .toString()
    .split('\n')[0]
    .trim();
};

const getDirectoryOfProcessById = (pid: number) => {
  return childProcess
    .execSync(
      `lsof -p ${pid} | grep cwd | awk '{print substr($0, index($0,$9))}'`,
      {
        encoding: 'utf-8',
      },
    )
    .toString()
    .trim();
};

const getCommandArgByPid = (pid: number, argIndex = 0) => {
  return childProcess
    .execSync(`ps -p ${pid} | awk '{print $${4 + argIndex}}'`, {
      encoding: 'utf-8',
    })
    .toString()
    .trim();
};

export const processIsJest = (pid: number) => {
  const commandArg = getCommandArgByPid(pid, 1);
  return commandArg.split('/').pop() === 'jest';
};

export const getProcessOnPort = async (
  port: number,
  shouldCheckTestResult?: boolean,
) => {
  if (shouldCheckTestResult) {
    const portTestResult = await detect(port);

    if (port === portTestResult) {
      return null;
    }
  }
  try {
    const pid = getProcessIdOnPort(port);
    const cwd = getDirectoryOfProcessById(parseInt(pid, 10));

    return {
      pid,
      cwd,
    };
  } catch (e) {
    return null;
  }
};

export const toIdentifier = (str: string) => {
  const IDENTIFIER_NAME_REPLACE_REGEX = /^([^a-zA-Z$_])/;
  const IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX = /[^a-zA-Z0-9$]+/g;

  return str
    .replace(IDENTIFIER_NAME_REPLACE_REGEX, '_$1')
    .replace(IDENTIFIER_ALPHA_NUMERIC_NAME_REPLACE_REGEX, '_');
};

export const tryRequire = (name: string) => {
  let absolutePath;

  try {
    absolutePath = require.resolve(name);
  } catch (e) {
    // The module has not found
    return null;
  }

  return require(absolutePath);
};

// Gets the artifact id of the project at the current working dir
export const getProjectArtifactId = (cwd = process.cwd()) => {
  if (fs.existsSync(path.join(cwd, POM_FILE))) {
    const content = fs.readFileSync(path.join(cwd, POM_FILE), 'utf-8');
    const artifactId = new xmldoc.XmlDocument(content).valueWithPath(
      'artifactId',
    );

    return artifactId;
  }

  return '';
};

export const getServerlessScope = (
  packageName: string,
  cwd = process.cwd(),
) => {
  const artifactVersion = inTeamCity()
    ? getProjectArtifactVersion(packageName).replace(/\./g, '-')
    : '0-0-0';

  return getProjectArtifactId(cwd) + '-' + artifactVersion;
};

export const getDevServerlessScope = (cwd = process.cwd()) => {
  const artifactVersion = '0-0-0';
  return getProjectArtifactId(cwd) + '-' + artifactVersion;
};

export const serverlessPort = '3000';

export const getServerlessBase = (scope: string) => {
  if (
    process.env.NODE_ENV === 'development' ||
    process.env.NODE_ENV === 'test'
  ) {
    return `http://localhost:${serverlessPort}/serverless/${scope}`;
  }
  return `/_serverless/${scope}`;
};

export const getProjectArtifactVersion = (packageName: string) => {
  return getBuildInfo().v1.packages[packageName].fingerprint;
};

// Gets the CDN base path for the project at the current working dir
export const getProjectCDNBasePath = (
  packageName: string,
  useUnversionedBaseUrl: boolean,
) => {
  const cdnUrl = getBuildInfo().v1.packages[packageName].artifact?.cdnUrl;

  if (!cdnUrl) {
    throw new Error(
      'Cannot get the CDN path for a package that has no static artifact',
    );
  }

  if (useUnversionedBaseUrl) {
    // Not to be confused with Yoshi's `dist` directory.
    //
    // Static assets are deployed to two locations on the CDN:
    //
    // - `https://static.parastorage.com/services/service-name/dist/asset.f43a1.js`
    // - `https://static.parastorage.com/services/service-name/1.2.3/asset.js`
    //
    // If this experimental feature is enabled, we can benefit from better caching by configuring
    // Webpack's `publicUrl` to use the first option.
    return cdnUrl.unversioned;
  }
  return cdnUrl.versioned;
};

export const killSpawnProcessAndHisChildren = (child: ChildProcess) => {
  return new Promise((resolve) => {
    if (!child) {
      return resolve();
    }

    const pid = child.pid;

    psTree(pid, (err, children) => {
      [pid]
        .concat(children.map((p) => parseInt(p.PID, 10)))
        .forEach((tpid: number) => {
          try {
            process.kill(tpid, 'SIGKILL');
          } catch (e) {}
        });
      resolve();
    });
  });
};

export const readJsonSilent = (jsonPath: string): Record<string, any> =>
  !fs.existsSync(jsonPath) ? {} : fs.readJSONSync(jsonPath);

export const stripOrganization = (name: string) =>
  name.slice(name.indexOf('/') + 1);
