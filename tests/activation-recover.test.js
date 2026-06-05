const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

async function requestJson(url, { expectStatus = 200, ...options } = {}) {
  const res = await fetch(url, options);
  const data = await readJsonResponse(res);
  assert.strictEqual(
    res.status,
    expectStatus,
    `expected ${expectStatus} from ${url}, got ${res.status}: ${JSON.stringify(data)}`,
  );
  return { res, data };
}

async function closeServers(servers) {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
}

test('activate recovers token for an already-activated machine when the code belongs to that machine', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-activation-recover-'));
  const storePath = path.join(tmpDir, 'data', 'proxies.json');
  const accountsDir = path.join(tmpDir, 'accounts');
  const machineId = 'machine-recover-test';
  const oldToken = 'old-token-value';
  const activationCode = 'FMA-RECOVER-0001';
  const issuedAt = '2026-06-05T00:00:00.000Z';

  writeJson(storePath, {
    version: 1,
    updatedAt: issuedAt,
    profiles: {},
    pool: [],
    nodes: [],
    activationCodes: [
      {
        code: activationCode,
        createdAt: issuedAt,
        expiresAt: null,
        ttlSec: null,
        usedAt: issuedAt,
        usedByMachineId: machineId,
      },
    ],
    machines: {
      [machineId]: {
        activatedAt: issuedAt,
        lastSeenAt: issuedAt,
        resetAt: null,
        tokenHash: sha256Hex(oldToken),
        allowedProfiles: ['522'],
        workerLimit: 3,
        note: 'keep me',
      },
    },
  });
  fs.mkdirSync(accountsDir, { recursive: true });

  process.env.PROXY_SERVICE_STORE = storePath;
  process.env.PROXY_SERVICE_ACCOUNTS_DIR = accountsDir;
  process.env.PROXY_ADMIN_PASSWORD = 'admin-password-for-test';
  process.env.PROXY_ADMIN_SESSION_SECRET = 'admin-session-secret-for-test';
  process.env.PROXY_SERVICE_HOST = '127.0.0.1';
  process.env.FLOW_MYSQL_URL = '';
  process.env.FLOW_MYSQL_HOST = '';
  process.env.FLOW_MYSQL_PORT = '';
  process.env.FLOW_MYSQL_USER = '';
  process.env.FLOW_MYSQL_PASSWORD = '';
  process.env.FLOW_MYSQL_DATABASE = '';

  const { startServer } = require('../server');
  const runtime = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    const activate = await requestJson(`${runtime.baseUrl}/v1/client/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId, activationCode }),
    });

    assert.equal(activate.data.ok, true);
    assert.equal(activate.data.machineId, machineId);
    assert.ok(activate.data.token, 'expected recovered token');
    assert.notEqual(activate.data.token, oldToken);
    assert.equal(activate.data.recovered, true);

    await requestJson(`${runtime.baseUrl}/v1/client/device`, {
      headers: { Authorization: `Bearer ${activate.data.token}` },
    });

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(store.machines[machineId].activatedAt, issuedAt);
    assert.deepEqual(store.machines[machineId].allowedProfiles, ['522']);
    assert.equal(store.machines[machineId].workerLimit, 3);
    assert.equal(store.machines[machineId].note, 'keep me');
    assert.equal(store.machines[machineId].tokenHash, sha256Hex(activate.data.token));
  } finally {
    await closeServers(runtime.servers);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server')];
  }
});

test('activate still rejects an already-activated machine when the used code belongs to another machine', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-activation-reject-'));
  const storePath = path.join(tmpDir, 'data', 'proxies.json');
  const accountsDir = path.join(tmpDir, 'accounts');
  const machineId = 'machine-reject-test';
  const activationCode = 'FMA-OTHER-0001';
  const issuedAt = '2026-06-05T00:10:00.000Z';

  writeJson(storePath, {
    version: 1,
    updatedAt: issuedAt,
    profiles: {},
    pool: [],
    nodes: [],
    activationCodes: [
      {
        code: activationCode,
        createdAt: issuedAt,
        expiresAt: null,
        ttlSec: null,
        usedAt: issuedAt,
        usedByMachineId: 'different-machine',
      },
    ],
    machines: {
      [machineId]: {
        activatedAt: issuedAt,
        lastSeenAt: issuedAt,
        resetAt: null,
        tokenHash: sha256Hex('old-token'),
        allowedProfiles: ['522'],
        workerLimit: 3,
        note: 'keep me',
      },
    },
  });
  fs.mkdirSync(accountsDir, { recursive: true });

  process.env.PROXY_SERVICE_STORE = storePath;
  process.env.PROXY_SERVICE_ACCOUNTS_DIR = accountsDir;
  process.env.PROXY_ADMIN_PASSWORD = 'admin-password-for-test';
  process.env.PROXY_ADMIN_SESSION_SECRET = 'admin-session-secret-for-test';
  process.env.PROXY_SERVICE_HOST = '127.0.0.1';
  process.env.FLOW_MYSQL_URL = '';
  process.env.FLOW_MYSQL_HOST = '';
  process.env.FLOW_MYSQL_PORT = '';
  process.env.FLOW_MYSQL_USER = '';
  process.env.FLOW_MYSQL_PASSWORD = '';
  process.env.FLOW_MYSQL_DATABASE = '';

  const { startServer } = require('../server');
  const runtime = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    const activate = await requestJson(`${runtime.baseUrl}/v1/client/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId, activationCode }),
      expectStatus: 409,
    });

    assert.equal(activate.data.error, 'machine already activated');
  } finally {
    await closeServers(runtime.servers);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server')];
  }
});

test('activate recovers token for an already-activated machine with a fresh unused code', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-activation-fresh-'));
  const storePath = path.join(tmpDir, 'data', 'proxies.json');
  const accountsDir = path.join(tmpDir, 'accounts');
  const machineId = 'machine-fresh-recover-test';
  const activationCode = 'FMA-FRESH-0001';
  const issuedAt = '2026-06-05T00:20:00.000Z';

  writeJson(storePath, {
    version: 1,
    updatedAt: issuedAt,
    profiles: {},
    pool: [],
    nodes: [],
    activationCodes: [
      {
        code: activationCode,
        createdAt: issuedAt,
        expiresAt: '2026-06-06T00:20:00.000Z',
        ttlSec: 86400,
        usedAt: null,
        usedByMachineId: null,
      },
    ],
    machines: {
      [machineId]: {
        activatedAt: issuedAt,
        lastSeenAt: issuedAt,
        resetAt: null,
        tokenHash: sha256Hex('old-token'),
        allowedProfiles: ['522'],
        workerLimit: 3,
        note: 'keep me',
      },
    },
  });
  fs.mkdirSync(accountsDir, { recursive: true });

  process.env.PROXY_SERVICE_STORE = storePath;
  process.env.PROXY_SERVICE_ACCOUNTS_DIR = accountsDir;
  process.env.PROXY_ADMIN_PASSWORD = 'admin-password-for-test';
  process.env.PROXY_ADMIN_SESSION_SECRET = 'admin-session-secret-for-test';
  process.env.PROXY_SERVICE_HOST = '127.0.0.1';
  process.env.FLOW_MYSQL_URL = '';
  process.env.FLOW_MYSQL_HOST = '';
  process.env.FLOW_MYSQL_PORT = '';
  process.env.FLOW_MYSQL_USER = '';
  process.env.FLOW_MYSQL_PASSWORD = '';
  process.env.FLOW_MYSQL_DATABASE = '';

  const { startServer } = require('../server');
  const runtime = await startServer({ port: 0, host: '127.0.0.1' });

  try {
    const activate = await requestJson(`${runtime.baseUrl}/v1/client/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId, activationCode }),
    });

    assert.equal(activate.data.ok, true);
    assert.equal(activate.data.machineId, machineId);
    assert.equal(activate.data.recovered, true);

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const codeEntry = store.activationCodes.find((item) => item.code === activationCode);
    assert.ok(codeEntry.usedAt);
    assert.equal(codeEntry.usedByMachineId, machineId);
  } finally {
    await closeServers(runtime.servers);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../server')];
  }
});
