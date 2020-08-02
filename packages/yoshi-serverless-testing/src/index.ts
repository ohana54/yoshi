const { app } = require('@wix/serverless-testkit');
const { getServerlessScope } = require('yoshi-helpers/build/utils');
const config = require('yoshi-config');

const scope = getServerlessScope(config.name);

// start the server as an embedded app
export const bootstrap = () => {
  return app(scope, { appPort: process.env.SERVERLESS_PORT });
};
