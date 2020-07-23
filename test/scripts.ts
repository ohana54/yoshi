import path from 'path';
import execa from 'execa';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import defaultsDeep from 'lodash/defaultsDeep';
import retry from 'async-retry';
import globby from 'globby';
import { testkit as ciBuildInfoTestkit } from '@wix/ci-build-info';
import { getDevServerlessScope } from '../packages/yoshi-helpers/build/utils';
import { ciEnv, localEnv } from '../scripts/utils/constants';
import serve from '../packages/yoshi-common/serve';
import writeJson from '../packages/yoshi-common/build/write-json';
import {
  waitForPort,
  waitForStdout,
  terminateAsyncSafe,
  terminateAsync,
  tmpDirectory,
  replaceTemplates,
  logMessage,
} from './utils';

const isPublish = !!process.env.WITH_PUBLISH;

const defaultOptions = {
  BROWSER: 'none',
};

const yoshiBin = require.resolve('../packages/yoshi/bin/yoshi-cli');
const yoshiFlowLibraryBin = require.resolve(
  '../packages/yoshi-flow-library/bin/yoshi-library',
);

type TestCallback = () => Promise<any>;

type TestCallbackWithResult = (
  result: execa.ExecaReturnValue<string>,
) => Promise<any>;

export type ProjectType =
  | 'typescript'
  | 'javascript'
  | 'yoshi-server-javascript'
  | 'yoshi-server-typescript'
  | 'yoshi-serverless-javascript'
  | 'yoshi-serverless-typescript'
  | 'monorepo-javascript'
  | 'monorepo-typescript'
  | 'flow-library';

type ScriptOpts = {
  args?: Array<string>;
  env?: { [key: string]: string };
  waitForStorybook?: boolean;
};

function createCiBuildInfo(rootDir: string, isMonorepo: boolean) {
  const packages = isMonorepo
    ? globby
        .sync(path.join(rootDir, 'packages/*'), { onlyFiles: false })
        .map((path) => ({ path }))
    : [{ path: rootDir }];
  const result = ciBuildInfoTestkit.createBuildInfo({
    packages,
  });

  return result;
}

export default class Scripts {
  private readonly verbose: boolean;
  public readonly testDirectory: string;
  private readonly serverProcessPort: number;
  private readonly staticsServerPort: number;
  private readonly storybookServerPort: number;
  public readonly serverUrl: string;
  public readonly serverlessDevUrl: string;
  private readonly yoshiPublishDir: string;
  public readonly staticsServerUrl: string;
  private readonly isMonorepo: boolean;
  private readonly projectType: ProjectType;
  private readonly yoshiBinToUse: string;
  private readonly ignoreWarnings: boolean;
  private readonly ciBuildInfoEnv: Record<string, string>;

  constructor({
    testDirectory,
    isMonorepo,
    projectType,
    yoshiBinToUse,
    ignoreWarnings = false,
  }: {
    testDirectory: string;
    isMonorepo: boolean;
    projectType: ProjectType;
    yoshiBinToUse: string;
    ignoreWarnings: boolean;
  }) {
    const { env: ciBuildInfoEnv } = createCiBuildInfo(
      testDirectory,
      isMonorepo,
    );
    this.ciBuildInfoEnv = ciBuildInfoEnv;
    this.ignoreWarnings = ignoreWarnings;
    this.verbose = !!process.env.DEBUG;
    this.testDirectory = testDirectory;
    this.serverProcessPort = 3000;
    this.staticsServerPort = projectType === 'flow-library' ? 3300 : 3200;
    this.storybookServerPort = 9009;
    this.serverUrl = `http://localhost:${this.serverProcessPort}`;
    /*
      We use this specialized `getDevServerlessScope` function instead of `getServerlessScope`
      because `getServerlessScope` automatically detects the environment (local/ci) and creates
      the scope according to that. But - the tests for serverless are running in the "local"
      environment (they run yoshi with environment variables simulating the local env),
      therefore they always need to use the dev scope. If we would've used `getServerlessScope` here,
      when these tests would run in CI - there will be a mismatch - since `getServerlessScope` will
      create a production scope, while yoshi (in the test itself) will get the dev scope
    */
    this.serverlessDevUrl = `http://localhost:${
      this.serverProcessPort
    }/serverless/${getDevServerlessScope(testDirectory)}`;
    this.staticsServerUrl = `http://localhost:${this.staticsServerPort}`;
    this.yoshiPublishDir = isPublish
      ? `${global.yoshiPublishDir}/node_modules`
      : projectType !== 'flow-library'
      ? path.join(__dirname, '../packages/yoshi-flow-legacy/node_modules')
      : path.join(__dirname, '../packages/yoshi-flow-library/node_modules');
    this.isMonorepo = isMonorepo;
    this.projectType = projectType;
    this.yoshiBinToUse = yoshiBinToUse;
  }

  static setupProjectFromTemplate({
    templateDir,
    projectType,
    ignoreWarnings = false,
  }: {
    templateDir: string;
    projectType: ProjectType;
    ignoreWarnings?: boolean;
  }) {
    // The test will run in '.tmp' folder. For example: '.tmp/javascript/features/css-inclusion'
    const featureDir = path.join(
      tmpDirectory,
      templateDir.replace(__dirname, ''),
    );
    // Create a folder for the specific feature, if does not exist
    fs.ensureDirSync(featureDir);
    // Copy the base template
    fs.copySync(
      path.join(__dirname, 'fixtures', projectType, 'base-template'),
      featureDir,
    );
    // Copy the specific feature template, with override
    fs.copySync(templateDir, featureDir, {
      overwrite: true,
      filter: (file) => !file.includes('.test.js'),
    });

    // Process tsconfig template for dynamic content
    const tsConfigPath = path.join(featureDir, 'tsconfig.json');
    if (fs.pathExistsSync(tsConfigPath)) {
      const templateData = {
        rootPath: path.join(__dirname, '..'),
      };
      const fileContents = fs.readFileSync(tsConfigPath, 'utf-8');
      const transformedContents = replaceTemplates(fileContents, templateData);
      fs.outputFileSync(tsConfigPath, transformedContents);
    }

    let yoshiBinToUse = yoshiBin;
    if (projectType === 'flow-library') {
      yoshiBinToUse = yoshiFlowLibraryBin;
    }

    let envVarsObj: { [key: string]: string } = {};
    if (projectType === 'yoshi-serverless-typescript') {
      envVarsObj = { EXPERIMENTAL_YOSHI_SERVERLESS: 'true' };
    }
    const envVars = Object.keys(envVarsObj).reduce((acc, cur) => {
      return `${cur}=${envVarsObj[cur]} ${acc}`;
    }, '');
    // Add scripts to package.json template
    const scripts = {
      scripts: {
        start: `${envVars}node ${yoshiBinToUse} start`,
        build: `${envVars}node ${yoshiBinToUse} build`,
        test: `${envVars}node ${yoshiBinToUse} test`,
      },
    };
    const packageJSONPath = path.join(featureDir, 'package.json');
    const packageJSONfileContents = require(packageJSONPath);
    const newPackageJSONfileContents = defaultsDeep(
      {},
      packageJSONfileContents,
      scripts,
    );

    writeJson(packageJSONPath, newPackageJSONfileContents);

    // we have __node_modules__ in our feature templates, in order to mock some devendency data
    if (fs.pathExistsSync(path.join(featureDir, '__node_modules__'))) {
      fs.moveSync(
        path.join(featureDir, '__node_modules__'),
        path.join(featureDir, 'node_modules'),
      );
    }

    // If this is a monorepo, run `yarn install` to symlink local modules
    const isMonorepo =
      projectType === 'monorepo-javascript' ||
      projectType === 'monorepo-typescript';

    if (isMonorepo) {
      const args = [
        path.resolve(
          require.resolve('lerna/package.json'),
          '..',
          require('lerna/package.json').bin.lerna,
        ),
        'link',
        '--force-local',
      ];

      execa.sync('node', args, {
        cwd: featureDir,
        stdio: 'inherit',
      });
    }

    return new Scripts({
      testDirectory: featureDir,
      isMonorepo,
      projectType,
      yoshiBinToUse,
      ignoreWarnings,
    });
  }

  private async waitForServerless() {
    // Wait for serverless testkit to be up
    return retry(
      async () => {
        const res = await fetch(`${this.serverlessDevUrl}/_api_`);

        const resStatus = await res?.status;
        if (resStatus === 406) {
          return;
        }
        throw new Error('Service is not up, yet');
      },
      {
        retries: 20,
      },
    );
  }

  async dev(
    callback: TestCallback = async () => {},
    opts: ScriptOpts & { extraStartArgs?: Array<string> } = {},
  ) {
    let startProcessOutput: string = '';

    const args = [this.yoshiBinToUse, 'start', ...(opts.extraStartArgs || [])];

    const startProcess = execa('node', [...args, ...(opts.args || [])], {
      cwd: this.testDirectory,
      env: {
        PORT: `${this.serverProcessPort}`,
        NODE_PATH: this.yoshiPublishDir,
        ...defaultOptions,
        ...(this.projectType === 'yoshi-serverless-typescript'
          ? { EXPERIMENTAL_YOSHI_SERVERLESS: 'true' }
          : {}),
        ...localEnv,
        ...opts.env,
      },
    });

    startProcess.stdout &&
      startProcess.stdout.on('data', (buffer) => {
        startProcessOutput += buffer.toString();
        if (this.verbose) {
          console.log(buffer.toString());
        }
      });

    startProcess.stderr &&
      startProcess.stderr.on('data', (buffer) => {
        startProcessOutput += buffer.toString();
        if (this.verbose) {
          console.log(buffer.toString());
        }
      });

    try {
      const errorsArray = [
        waitForStdout(startProcess, 'Failed to compile', {
          throttle: true,
        }).then(() => {
          throw new Error(
            `Yoshi start failed to compile: \n \n ${startProcessOutput}`,
          );
        }),
      ];
      if (!this.ignoreWarnings) {
        errorsArray.push(
          waitForStdout(startProcess, 'Compiled with warnings', {
            throttle: true,
          }).then(() => {
            throw new Error(
              `Yoshi start was compiled with warnings \n \n ${startProcessOutput}`,
            );
          }),
        );
      }

      // `startProcess` will never resolve but if it fails this
      // promise will reject immediately
      await Promise.race([
        ...errorsArray,
        Promise.all([
          this.projectType !== 'flow-library'
            ? waitForPort(this.serverProcessPort, { timeout: 60 * 1000 })
            : Promise.resolve(),
          waitForPort(this.staticsServerPort, { timeout: 60 * 1000 }),
          !this.ignoreWarnings
            ? waitForStdout(startProcess, 'Compiled successfully!')
            : Promise.resolve(''),
          opts.waitForStorybook
            ? waitForPort(this.storybookServerPort, { timeout: 60 * 1000 })
            : Promise.resolve(),
          this.projectType === 'yoshi-serverless-typescript'
            ? this.waitForServerless()
            : Promise.resolve(),
        ]),
        startProcess,
      ]);

      await callback();
    } catch (e) {
      logMessage('Yoshi Start Output:', startProcessOutput);
      throw e;
    } finally {
      await terminateAsyncSafe(startProcess.pid);
    }
  }

  async analyze(callback: TestCallback = async () => {}) {
    let buildProcessOutput: string = '';

    const buildProcess = execa(
      'node',
      [this.yoshiBinToUse, 'build', '--analyze'],
      {
        cwd: this.testDirectory,
        env: {
          ...defaultOptions,
          ...localEnv,
          ANALYZE_PORT: '8888',
        },
      },
    );

    buildProcess.stdout &&
      buildProcess.stdout.on('data', (buffer) => {
        buildProcessOutput += buffer.toString();
        if (this.verbose) {
          console.log(buffer.toString());
        }
      });

    buildProcess.stderr &&
      buildProcess.stderr.on('data', (buffer) => {
        buildProcessOutput += buffer.toString();
        if (this.verbose) {
          console.log(buffer.toString());
        }
      });

    try {
      await callback();
    } catch (e) {
      logMessage('Yoshi Build Output:', buildProcessOutput);
      throw e;
    } finally {
      terminateAsync(buildProcess.pid);
    }
  }

  async build(env: Record<string, string> = {}, args: Array<string> = []) {
    let buildResult;

    try {
      buildResult = await execa(
        'node',
        [this.yoshiBinToUse, 'build', ...args],
        {
          cwd: this.testDirectory,
          env: {
            ...defaultOptions,
            ...env,
          },
          all: true,
        },
      );
    } catch (e) {
      throw new Error(e.all);
    }

    if (this.verbose) {
      console.log(buildResult.all);
    }

    if (buildResult.stdout.includes('Compiled with warnings')) {
      throw new Error(
        `Yoshi build was compiled with warnings: \n ${buildResult.stdout}`,
      );
    }

    return buildResult;
  }

  async serve(
    resolve: TestCallback,
    reject: (reason: Error) => void = () => {},
  ) {
    const curDir = process.cwd();
    process.chdir(this.testDirectory);

    try {
      const stop = await serve();
      await resolve();
      await stop();
    } catch (e) {
      reject(e);
    }

    process.chdir(curDir);
  }

  async test(mode: 'prod' | 'dev') {
    const env = mode === 'prod' ? ciEnv : localEnv;
    let res;
    try {
      res = await execa('node', [this.yoshiBinToUse, 'test'], {
        cwd: this.testDirectory,
        all: true,
        env: {
          NODE_PATH: this.yoshiPublishDir,
          ...defaultOptions,
          ...env,
          ...this.ciBuildInfoEnv,
        },
      });
    } catch (e) {
      throw new Error(e.all);
    }
    return res;
  }

  async prod(
    callback: TestCallbackWithResult = async () => {},
    opts: ScriptOpts & { staticsDir?: string } = {},
  ) {
    const buildResult = await this.build(
      { ...ciEnv, ...opts.env, ...this.ciBuildInfoEnv },
      opts.args,
    );

    const staticsServerProcess = execa(
      'npx',
      [
        'serve',
        '-p',
        `${this.staticsServerPort}`,
        '-s',
        opts.staticsDir || 'dist/statics/',
      ],
      {
        cwd: this.testDirectory,
      },
    );

    const appServerProcess = execa('node', ['./index.js'], {
      cwd: this.testDirectory,
      env: {
        NODE_PATH: this.yoshiPublishDir,
        PORT: `${this.serverProcessPort}`,
        IS_INTEGRATION_TEST_PROD: 'true',
        ...opts.env,
      },
      all: true,
    });

    let serverOutput = '';

    appServerProcess.all &&
      appServerProcess.all.on('data', (d) => {
        serverOutput += d.toString();
      });

    try {
      // wait for staticsServerPort && (serverProcessPort || error in server)
      await Promise.all([
        waitForPort(this.staticsServerPort),
        Promise.race([waitForPort(this.serverProcessPort), appServerProcess]),
      ]);

      await callback(buildResult);
    } catch (e) {
      logMessage('Yoshi Build Output:', buildResult.all as string);
      serverOutput && logMessage('Server Results:', serverOutput);
      throw e;
    } finally {
      await Promise.all([
        terminateAsyncSafe(staticsServerProcess.pid),
        terminateAsyncSafe(appServerProcess.pid),
      ]);
    }
  }
}
