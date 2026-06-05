const assert = require('assert');
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

async function readJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid json response: ${text}`);
  }
}

async function requestJson(url, { expectStatus = 200, ...options } = {}) {
  const res = await fetch(url, options);
  const data = await readJson(res);
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
          server.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    ),
  );
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-service-reissue-token-'));
  const storePath = path.join(tmpDir, 'data', 'proxies.json');
  const accountsDir = path.join(tmpDir, 'accounts');
  const machineId = 'machine-reissue-test';
  const oldToken = 'old-client-token';
  const issuedAt = '2026-06-01T00:00:00.000Z';

  writeJson(storePath, {
    version: 1,
    updatedAt: issuedAt,
    profiles: {},
    pool: [],
    nodes: [],
    activationCodes: [],
    machines: {
      [machineId]: {
        activatedAt: issuedAt,
        lastSeenAt: issuedAt,
        resetAt: null,
        tokenHash: sha256Hex(oldToken),
        allowedProfiles: ['522'],
        workerLimit: 9,
        note: 'keep assignments',
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
    const login = await requestJson(`${runtime.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.PROXY_ADMIN_PASSWORD }),
    });
    const cookie = login.res.headers.get('set-cookie');
    assert.ok(cookie, 'expected admin login to set cookie');

    const reissue = await requestJson(`${runtime.baseUrl}/v1/admin/machines/${machineId}/reissue-token`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.strictEqual(reissue.data.ok, true);
    assert.strictEqual(reissue.data.machineId, machineId);
    assert.ok(reissue.data.token, 'expected plaintext token in reissue response');
    assert.notStrictEqual(reissue.data.token, oldToken, 'reissue should rotate token');
    assert.deepStrictEqual(reissue.data.allowedProfiles, ['522']);
    assert.strictEqual(reissue.data.workerLimit, 9);
    assert.strictEqual(reissue.data.note, 'keep assignments');
    assert.ok(reissue.data.tokenReissuedAt, 'expected tokenReissuedAt in response');

    await requestJson(`${runtime.baseUrl}/v1/client/device`, {
      expectStatus: 401,
      headers: { Authorization: `Bearer ${oldToken}` },
    });

    const device = await requestJson(`${runtime.baseUrl}/v1/client/device`, {
      headers: { Authorization: `Bearer ${reissue.data.token}` },
    });
    assert.strictEqual(device.data.ok, true);
    assert.strictEqual(device.data.machineId, machineId);
    assert.deepStrictEqual(device.data.allowedProfiles, ['522']);
    assert.strictEqual(device.data.workerLimit, 9);

    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.ok(store.machines[machineId], 'expected machine to remain in store');
    assert.deepStrictEqual(store.machines[machineId].allowedProfiles, ['522']);
    assert.strictEqual(store.machines[machineId].workerLimit, 9);
    assert.strictEqual(store.machines[machineId].note, 'keep assignments');
    assert.strictEqual(store.machines[machineId].resetAt, null);
    assert.strictEqual(store.machines[machineId].activatedAt, issuedAt);
    assert.notStrictEqual(store.machines[machineId].tokenHash, sha256Hex(oldToken));
    assert.strictEqual(store.machines[machineId].tokenHash, sha256Hex(reissue.data.token));
    assert.ok(store.machines[machineId].tokenReissuedAt, 'expected tokenReissuedAt in store');

    console.log('test-reissue-token: ok');
  } finally {
    await closeServers(runtime.servers);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`test-reissue-token: ${err?.message || err}`);
  process.exit(1);
});
