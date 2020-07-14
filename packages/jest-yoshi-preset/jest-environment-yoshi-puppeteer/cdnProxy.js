const startRewriteForwardProxy = require('yoshi-helpers/build/rewrite-forward-proxy')
  .default;
const { getProjectCDNBasePath } = require('yoshi-helpers/utils');
const {
  servers,
  experimentalBuildHtml,
  name: packageName,
} = require('yoshi-config');

let closeProxy;

module.exports.start = async function start(port) {
  closeProxy = await startRewriteForwardProxy({
    search: getProjectCDNBasePath(packageName, experimentalBuildHtml),
    rewrite: servers.cdn.url,
    port,
  });
};

module.exports.stop = async function stop() {
  closeProxy && (await closeProxy());
};
