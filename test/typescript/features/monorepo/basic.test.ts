import fs from 'fs';
import path from 'path';
import rimraf from 'rimraf';
import Scripts from '../../../scripts';
import { localEnv } from '../../../../scripts/utils/constants';

const scripts = Scripts.setupProjectFromTemplate({
  templateDir: __dirname,
  projectType: 'monorepo-typescript',
});

describe('monorepo', () => {
  it('basic integration [prod]', async () => {
    await scripts.prod(
      async () => {
        await page.goto(`${scripts.serverUrl}`);
        const innerHTML = await page.$eval('#name', (elm) => elm.textContent);

        expect(innerHTML).toEqual('hello from app!');
      },
      {
        staticsDir: 'packages/app/dist/statics',
      },
    );
  });

  it('basic integration [dev]', async () => {
    await scripts.dev(
      async () => {
        await page.goto(`${scripts.serverUrl}`);
        const innerHTML = await page.$eval('#name', (elm) => elm.textContent);

        expect(innerHTML).toEqual('hello from app!');
      },
      { extraStartArgs: ['monorepo-app'] },
    );
  });

  it('selective build', async () => {
    rimraf.sync(path.join(scripts.testDirectory, 'packages/*/dist'));

    await scripts.build(localEnv, ['monorepo-app']);
    const bundlePath = 'dist/statics/app.bundle.js';

    expect(
      fs.existsSync(
        path.join(scripts.testDirectory, 'packages/app', bundlePath),
      ),
    ).toBe(true);

    expect(
      fs.existsSync(
        path.join(scripts.testDirectory, 'packages/app-b', bundlePath),
      ),
    ).toBe(false);
  });
});
