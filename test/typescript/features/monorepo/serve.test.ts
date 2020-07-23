import monorepoServe from 'yoshi-flow-monorepo/serve';
import Scripts from '../../../scripts';
import { localEnv } from '../../../../scripts/utils/constants';

const scripts = Scripts.setupProjectFromTemplate({
  templateDir: __dirname,
  projectType: 'monorepo-typescript',
});

describe('monorepo', () => {
  let stopServers: () => {} | undefined;

  it('serves a built monorepo', async () => {
    const monorepoRoot = scripts.testDirectory;
    await scripts.build(localEnv);

    stopServers = await monorepoServe({ cwd: monorepoRoot });

    await page.goto('http://localhost:3000');
    const firstAppHtml = await page.$eval('#name', (elm) => elm.textContent);

    expect(firstAppHtml).toEqual('hello from app!');

    await page.goto('http://localhost:4000');
    const secondAppHtml = await page.$eval('#name', (elm) => elm.textContent);

    expect(secondAppHtml).toEqual('hello from app-b!');
  });

  afterEach(() => {
    // eslint-disable-next-line no-unused-expressions
    stopServers?.();
  });
});
