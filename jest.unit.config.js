module.exports = {
  testMatch: ['**/__tests__/**/*.test.(js|ts)'],
  testResultsProcessor: 'jest-teamcity',
  testPathIgnorePatterns: [
    '/packages/create-yoshi-app/templates/',
    '/build/',
    '/node_modules/',
    '/test/',
  ],
  watchPathIgnorePatterns: ['node_modules'],
  transform: {
    '^.+\\.jsx?$': 'babel-jest',
    '^.+\\.tsx?$': 'ts-jest',
  },
};
