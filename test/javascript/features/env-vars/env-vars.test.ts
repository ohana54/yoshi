import axios from 'axios';
import Scripts from '../../../scripts';

const scripts = Scripts.setupProjectFromTemplate({
  templateDir: __dirname,
  projectType: 'javascript',
});

describe.each(['prod', 'dev'] as const)('env-vars [%s]', (mode) => {
  it('supports prod NODE_ENV', async () => {
    await scripts[mode](async () => {
      await page.goto(scripts.serverUrl);

      const result = await page.$eval(
        '#env-vars #node-env',
        (elm) => elm.textContent,
      );

      if (mode === 'dev') {
        expect(result).toEqual('development');
      } else {
        expect(result).toEqual('production');
      }
    });
  });

  it('supports __CI_APP_VERSION__', async () => {
    await scripts[mode](async () => {
      await page.goto(scripts.serverUrl);

      const result = await page.$eval(
        '#env-vars #ci-app-version',
        (elm) => elm.textContent,
      );

      if (mode === 'dev') {
        expect(result).toEqual('0.0.0');
      } else {
        expect(result).toEqual('1.0.0');
      }
    });
  });

  it('supports browser env var on browser side', async () => {
    await scripts[mode](async () => {
      await page.goto(scripts.serverUrl);

      const result = await page.$eval(
        '#env-vars #browser',
        (elm) => elm.textContent,
      );

      expect(result).toEqual('true');
    });
  });

  it('supports browser env var on server side', async () => {
    await scripts[mode](async () => {
      await page.goto(scripts.serverUrl);

      const { data } = await axios.get('http://localhost:3000/env-var-browser');

      expect(data).toEqual(false);
    });
  });
});
