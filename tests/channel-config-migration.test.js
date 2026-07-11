const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_DIR = path.resolve(__dirname, '..');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('module bootstrap migrates legacy seedance config to provider3 default', () => {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-data-'));
  const channelsPath = path.join(tempDataDir, 'channels.json');
  const legacyConfig = {
    version: 1,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '1',
        providers: [
          {
            key: '1',
            label: '服务商 1',
            enabled: true,
            runner_key: 'seedance.provider1',
            base_url: 'https://testapi.genvia.ai',
            model: 'dreamina-seedance-2-0-260128',
          },
        ],
      },
    ],
  };
  fs.writeFileSync(channelsPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, 'utf8');

  const result = spawnSync(process.execPath, ['-e', 'require("./server.js")'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PROXY_SERVICE_DATA_DIR: tempDataDir,
    },
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `expected bootstrap require to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const migrated = readJson(channelsPath);
  const seedance = migrated.channels.find((channel) => channel.key === 'seedance');
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  assert.equal(migrated.version, 2);
  assert.equal(seedance.selected_provider, '3');
  assert.ok(
    seedance.providers.some((provider) => provider.key === '2' && provider.runner_key === 'seedance.provider2'),
    'expected startup migration to add seedance.provider2',
  );
  assert.ok(
    seedance.providers.some((provider) => provider.key === '3' && provider.runner_key === 'seedance.provider3'),
    'expected startup migration to add seedance.provider3',
  );
});

test('module bootstrap keeps explicit version 2 provider selection', () => {
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-data-'));
  const channelsPath = path.join(tempDataDir, 'channels.json');
  const explicitConfig = {
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '1',
        providers: [
          {
            key: '1',
            label: '服务商 1',
            enabled: true,
            runner_key: 'seedance.provider1',
          },
          {
            key: '2',
            label: '服务商 2 (BytePlus)',
            enabled: true,
            runner_key: 'seedance.provider2',
          },
        ],
      },
    ],
  };
  fs.writeFileSync(channelsPath, `${JSON.stringify(explicitConfig, null, 2)}\n`, 'utf8');

  const result = spawnSync(process.execPath, ['-e', 'require("./server.js")'], {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      PROXY_SERVICE_DATA_DIR: tempDataDir,
    },
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `expected bootstrap require to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const migrated = readJson(channelsPath);
  const seedance = migrated.channels.find((channel) => channel.key === 'seedance');
  fs.rmSync(tempDataDir, { recursive: true, force: true });
  assert.equal(migrated.version, 2);
  assert.equal(seedance.selected_provider, '1');
});
