const tempy = require('tempy');
const execa = require('execa');
const chalk = require('chalk');
const expect = require('expect');
const flatMap = require('lodash/flatMap');
const fs = require('fs');
const mock = require('mock-require');

const { verifyRegistry } = require('../src/index');
const { isOutOfIframe, isAppBuilder, isBMFlow } = require('../src/utils');
const TemplateModel = require('../src/TemplateModel').default;
const { publishMonorepo } = require('../../../scripts/utils/publishMonorepo');
const { testRegistry, localEnv } = require('../../../scripts/utils/constants');
const templates = require('../src/templates').default;

// A regex pattern to run a focus test on the matched projects types
const focusProjects = process.env.FOCUS_PROJECTS;

verifyRegistry();

// add `${template}-typescript` to support legacy filter by title
const templatesWithTitles = flatMap(templates, (templateDefinition) => {
  return templateDefinition.availableLanguages.map((language) => {
    return {
      ...templateDefinition,
      title: `${templateDefinition.name}-${language}`,
    };
  });
});

const filteredTemplates = templatesWithTitles.filter(({ title }) =>
  !focusProjects ? true : focusProjects.split(',').includes(title),
);

const mockAppData = (data) => {
  mock('../src/runPrompt', { default: async () => data });
};

const mockFlowData = (title, type) => {
  mock('../src/dev-center-registration/runPrompt', {
    default: async () => {
      return {
        appDefinitionId: 'APP_DEF_ID',
        appName: `test-${title}`,
        components: [
          {
            name: 'myapp',
            id: 'BUTTON_ID',
            type,
          },
        ],
      };
    },
  });
};

const mockSentryData = (teamName, projectName) => {
  mock('../src/sentry-registration/runPrompt', {
    default: async () => {
      return {
        teamName: `test-${teamName}`,
        projectName: `test-${projectName}`,
        DSN: 'https://foo@bar/baz',
        id: 'xxx',
      };
    },
  });
};

const mockAutoRelease = () => {
  mock('../src/auto-release/setupAutoRelease', {
    default: async () => {
      return null;
    },
  });
};

if (filteredTemplates.length === 0) {
  console.log(
    chalk.red('Could not find any project for the specified projects:'),
  );
  console.log();
  console.log(chalk.cyan(focusProjects));
  console.log();
  console.log('try to use one for the following:');
  console.log();
  console.log(
    templatesWithTitles.map((p) => `> ${chalk.magenta(p.title)}`).join('\n'),
  );
  console.log();
  process.exit(1);
}

console.log('Running e2e tests for the following templates:\n');
filteredTemplates.forEach(({ title }) => console.log(`> ${chalk.cyan(title)}`));

const testTemplate = (mockedAnswers) => {
  describe(mockedAnswers.getTitle(), () => {
    const testDirectory = `${tempy.directory()}/${mockedAnswers.projectName}`;
    fs.mkdirSync(testDirectory);

    // Executes and logs output if errored
    const exec = async (cmd, env) => {
      try {
        return await execa(cmd, {
          shell: true,
          all: true,
          cwd: testDirectory,
          // Make sure yoshi doesn't run in CI mode, which requires simulating
          // the CI environment. If it is needed in the future, we can use
          // @wix/ci-build-info testkit like we do in test/scripts.ts
          env: Object.assign({}, env, localEnv),
        });
      } catch (err) {
        console.error(err.all);
        return err;
      }
    };

    // !!!************************** Important Notice **************************!!!
    // this test case sets up the environment
    // for the following test cases. So test case execution order is important!
    // If you nest a describe here (and the tests are run by mocha) the test cases
    // in the describe block will run first!
    it('step 1: should generate project successfully', async () => {
      mockAppData(mockedAnswers);
      if (isOutOfIframe(mockedAnswers.templateDefinition.name)) {
        mockFlowData(
          mockedAnswers.templateDefinition.title,
          'WIDGET_OUT_OF_IFRAME',
        );
        mockSentryData(
          'some-team',
          mockedAnswers.templateDefinition.projectName,
        );
        mockAutoRelease();
      } else if (isAppBuilder(mockedAnswers.templateDefinition.name)) {
        mockFlowData(mockedAnswers.templateDefinition.title, 'STUDIO_WIDGET');
        mockSentryData(
          'some-team',
          mockedAnswers.templateDefinition.projectName,
        );
        mockAutoRelease();
      } else if (isBMFlow(mockedAnswers.templateDefinition.name)) {
        mockSentryData(
          'some-team',
          mockedAnswers.templateDefinition.projectName,
        );
      }
      const { createApp } = mock.reRequire('../src/index');

      // This sets the local registry as the NPM registry to use, so templates are installed from local registry
      process.env['npm_config_registry'] = testRegistry;
      await createApp({ workingDir: testDirectory });
    });

    if (mockedAnswers.language === 'typescript') {
      it('should not have errors on typescript strict check', async () => {
        console.log('checking strict typescript...');

        const result = await exec('./node_modules/.bin/tsc --noEmit --strict');

        if (result.exitCode !== 0) {
          console.log(result.stderr);
          console.log(result.stdout);
          throw new Error(
            `"tsc --noEmit --strict" exited with code ${result.exitCode}.\nPlease see above for its output.`,
          );
        }
      });
    }

    it('step 2: should run npm run build with no configuration warnings', async () => {
      console.log('running npm build...');

      const buildResult = await exec('npm run build');

      if (buildResult.exitCode !== 0) {
        console.log(buildResult.stderr);
        console.log(buildResult.stdout);
        throw new Error(
          `"npm run build" exited with code ${buildResult.exitCode}.\nPlease see above for its output.`,
        );
      }
      expect(buildResult.stderr).not.toContain(
        'Warning: Invalid configuration object',
      );
    });

    it('step 3: should run npm test', async () => {
      console.log('running npm test...');

      const testResult = await exec('npm test', {
        VCS_BRANCH_NAME: undefined,
      });

      if (testResult.exitCode !== 0) {
        throw new Error(
          `"npm test" exited with code ${testResult.exitCode}.\nPlease see above for its output.`,
        );
      }
    });
  });
};

describe('create-yoshi-app + yoshi e2e tests', () => {
  let cleanup;

  before(() => {
    cleanup = publishMonorepo();
  });

  after(() => cleanup());

  filteredTemplates
    .map(
      (templateDefinition) =>
        new TemplateModel({
          projectName: `test-${templateDefinition.title}`,
          templateDefinition,
          authorName: 'rany',
          authorEmail: 'rany@wix.com',
          language: templateDefinition.title.endsWith('-typescript')
            ? 'typescript'
            : 'javascript',
        }),
    )
    .forEach(testTemplate);
});
