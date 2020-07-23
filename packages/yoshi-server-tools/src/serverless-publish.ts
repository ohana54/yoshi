import path from 'path';
import simpleGit from 'simple-git';
import retry from 'async-retry';
import fetch from 'node-fetch';
import fs from 'fs-extra';
import { Config } from 'yoshi-config/build/config';
import {
  getServerlessScope,
  getServerlessBase,
} from 'yoshi-helpers/build/utils';

export default async function publishServerless(config: Config) {
  if (!config.yoshiServer || !process.env.EXPERIMENTAL_YOSHI_SERVERLESS) {
    return;
  }
  console.log('Publishing to Serverless');
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve('package.json'), 'utf-8'),
  );

  const ambassadorRegex = /@wix\/ambassador-.+/;
  const dependencies = Object.keys(packageJson.dependencies).reduce(
    (acc, key) => {
      if (ambassadorRegex.test(key)) {
        return { ...acc, [key]: packageJson.dependencies[key] };
      }
      return acc;
    },
    {},
  );

  console.log('Deploy command:');
  console.log(`deploy #serverless ${getServerlessScope(config.name)}`);
  const git = simpleGit(__dirname);

  console.log('cloning git@github.com:wix-a/yoshi-serverless.git');
  await git.clone(
    'git@github.com:wix-a/yoshi-serverless.git',
    path.resolve('temp'),
    { depth: 1 },
  );
  console.log('clone complete');

  fs.copySync(path.resolve('serverless'), path.resolve('temp/serverless'));
  if (Object.keys(dependencies).length) {
    fs.writeFileSync(
      path.resolve(
        `temp/serverless/${getServerlessScope(config.name)}/package.json`,
      ),
      JSON.stringify({ dependencies }, null, 2),
    );
  }
  await git.cwd(path.resolve('temp'));
  await git.add('serverless/*');
  await git.commit(`deploy ${getServerlessScope(config.name)}`, '--no-verify');
  await git.push('origin', 'master');
  // deploy to Yoshi Serverless sandbox
  fetch(
    `https://bo.wix.com/yoshi-serverless-deploy-facade/moveDeploymentToArtifact/${getServerlessScope(
      config.name,
    )}`,
  );
  // Wait for Publish to Serverless to be finished
  await retry(
    async () => {
      console.log('Ping to check if Service is up');
      const res = await fetch(
        `http://www.wix.com${getServerlessBase(
          getServerlessScope(config.name),
        )}/_api_`,
      );
      const resStatus = await res?.status;

      if (resStatus === 406) {
        return;
      }
      console.log('Service is not up, yet');
      throw new Error('Service is not up, yet');
    },
    {
      retries: 20,
    },
  );
  console.log('Publish to Serverless complete');
}
