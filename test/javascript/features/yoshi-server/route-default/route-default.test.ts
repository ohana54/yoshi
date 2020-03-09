import Scripts from '../../../../scripts';

const scripts = Scripts.setupProjectFromTemplate({
  templateDir: __dirname,
  projectType: 'yoshi-server-javascript',
});

describe.each(['prod', 'dev'] as const)(
  'yoshi-server default route [%s]',
  mode => {
    it('run tests', async () => {
      await scripts[mode](async () => {
        await page.goto(`${scripts.serverUrl}`);
        const title = await page.$eval('h1', elm => elm.textContent);
        expect(title).toBe('hello from yoshi server');
      });
    });
  },
);
