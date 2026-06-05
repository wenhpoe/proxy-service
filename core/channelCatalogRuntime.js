const {
  buildClientChannelCatalog,
  readChannelConfigFile,
  writeChannelConfigFile,
} = require('./channelConfig');

async function loadRuntimeCatalog({ store, materializedPath }) {
  try {
    const catalog = await store.loadCatalog();
    writeChannelConfigFile(materializedPath, catalog);
    return readChannelConfigFile(materializedPath);
  } catch {
    return readChannelConfigFile(materializedPath);
  }
}

function buildClientCatalogFromRuntime(catalog) {
  return buildClientChannelCatalog(catalog);
}

module.exports = {
  buildClientCatalogFromRuntime,
  loadRuntimeCatalog,
};
