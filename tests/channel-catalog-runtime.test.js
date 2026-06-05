const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadRuntimeCatalog } = require('../core/channelCatalogRuntime');

test('loadRuntimeCatalog returns mysql catalog and rewrites materialized file', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-runtime-'));
  const materializedPath = path.join(tempDir, 'channels.json');
  const mysqlCatalog = {
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '2',
        providers: [{ key: '2', label: '服务商 2', enabled: true, runner_key: 'seedance.provider2' }],
      },
    ],
  };
  const runtime = {
    store: { loadCatalog: async () => mysqlCatalog },
    materializedPath,
  };

  const catalog = await loadRuntimeCatalog(runtime);
  const written = JSON.parse(fs.readFileSync(materializedPath, 'utf8'));

  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(catalog.channels[0].selected_provider, '2');
  assert.equal(written.channels[0].providers[0].runner_key, 'seedance.provider2');
});

test('loadRuntimeCatalog falls back to file when mysql load fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-runtime-'));
  const materializedPath = path.join(tempDir, 'channels.json');
  fs.writeFileSync(materializedPath, JSON.stringify({
    version: 2,
    channels: [
      {
        key: 'flow',
        label: 'Flow',
        enabled: true,
        selected_provider: '1',
        providers: [{ key: '1', label: '服务商 1', enabled: true, runner_key: 'flow.provider1' }],
      },
    ],
  }, null, 2));

  const catalog = await loadRuntimeCatalog({
    store: { loadCatalog: async () => { throw new Error('mysql disabled'); } },
    materializedPath,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(catalog.channels[0].key, 'flow');
});
