import { Page } from 'puppeteer';
import Scripts from '../../../../scripts';

jest.setTimeout(70 * 1000);

const scripts = Scripts.setupProjectFromTemplate({
  templateDir: __dirname,
  projectType: 'yoshi-serverless-typescript',
  ignoreWarnings: true,
});

describe.each(['dev'] as const)(
  'yoshi-serverless api client to server - show an error message for development [%s]',
  (mode) => {
    let page: Page;
    afterEach(() => page.close());
    it('run tests', async () => {
      await scripts[mode](async () => {
        // the default page instance has an error handler which
        // fails tests in case of an error while navigation
        page = await browser.newPage();

        await page.goto(`${scripts.serverlessDevUrl}/app`);
        await page.waitForSelector('.popover');
        expect(await page.$eval('.popover', (el) => el.innerHTML)).toMatch(
          'A cool error',
        );
      });
    });
  },
);
