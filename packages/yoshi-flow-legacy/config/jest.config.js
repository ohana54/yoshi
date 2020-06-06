const merge = require('lodash/merge');
const projectConfig = require('yoshi-config');
const { inTeamCity } = require('yoshi-helpers/build/queries');

const jestProjectConfig = projectConfig.jestConfig;

const config = merge(
  {
    transform: {
      '\\.jsx?$': require.resolve('./jest-transformer'),
      '\\.st.css?$': require.resolve('yoshi-common/build/@stylable/jest'),
      '\\.svg$': require.resolve('./svg-transformer.js'),
    },
  },
  jestProjectConfig,
);

config.transformIgnorePatterns = (config.transformIgnorePatterns || []).concat([
  '/node_modules/(?!(.*?\\.(st\\.css|svg)$))',
]);

if (inTeamCity()) {
  config.testResultsProcessor = require.resolve('jest-teamcity');
}

module.exports = config;
