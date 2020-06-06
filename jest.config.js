module.exports = {
  preset: 'jest-puppeteer',
  runner: './config/serial-runner.js',
  rootDir: './test',
  verbose: true,
  testResultsProcessor: 'jest-teamcity',
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: require.resolve('./test/globalSetup.ts'),
  globalTeardown: require.resolve('./test/globalTeardown.ts'),
  transformIgnorePatterns: ['/node_modules/'],
  setupFilesAfterEnv: [require.resolve('./jest-setup.ts')],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};
