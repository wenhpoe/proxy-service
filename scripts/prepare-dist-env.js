const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ADMIN_PASSWORD = '123456';

const ALLOWED_KEY_PREFIXES = ['PROXY_', 'FLOW_MYSQL_'];
const ALLOWED_KEYS = new Set(['FLOW_MYSQL_URL']);
const REQUIRED_PROXY_KEYS = ['PROXY_ADMIN_PASSWORD', 'PROXY_ADMIN_SESSION_SECRET'];
const MYSQL_KEY_GROUPS = [
  ['FLOW_MYSQL_URL'],
  ['FLOW_MYSQL_HOST', 'FLOW_MYSQL_USER', 'FLOW_MYSQL_DATABASE'],
];

function renderDefaultEnv() {
  return [
    `PROXY_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD}`,
    `PROXY_ADMIN_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`,
    '',
  ].join('\n');
}

function parseEnvEntries(text) {
  const entries = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const raw = String(line || '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (ALLOWED_KEYS.has(key) || ALLOWED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      entries.push({ key, value });
    }
  }
  return entries;
}

function entriesToMap(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.key, entry.value);
  return map;
}

function hasValue(map, key) {
  return map.has(key) && String(map.get(key) || '').trim() !== '';
}

function missingMysqlKeys(map) {
  if (MYSQL_KEY_GROUPS.some((group) => group.every((key) => hasValue(map, key)))) return [];
  return ['FLOW_MYSQL_URL or FLOW_MYSQL_HOST/FLOW_MYSQL_USER/FLOW_MYSQL_DATABASE'];
}

function renderEnv(entries) {
  const seen = new Set();
  const out = [
    '# Bundled by proxy-service/scripts/prepare-dist-env.js for packaged releases.',
    '# User-level overrides still live in <userData>/.env.',
  ];
  for (const entry of entries) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push(`${entry.key}=${entry.value}`);
  }
  out.push('');
  return out.join('\n');
}

function main() {
  const root = path.join(__dirname, '..');
  const src = path.join(root, '.env');
  const outDir = path.join(root, 'build');
  const dst = path.join(outDir, 'bundled.env');

  fs.mkdirSync(outDir, { recursive: true });

  if (!fs.existsSync(src)) {
    fs.writeFileSync(dst, renderDefaultEnv(), 'utf8');
    process.stdout.write(`ℹ️ No proxy-service/.env found; wrote default bundled env (${DEFAULT_ADMIN_PASSWORD}).\n`);
    return;
  }

  const entries = parseEnvEntries(fs.readFileSync(src, 'utf8'));
  const map = entriesToMap(entries);
  const missingProxy = REQUIRED_PROXY_KEYS.filter((key) => !hasValue(map, key));
  const missingMysql = missingMysqlKeys(map);

  if (missingProxy.length || missingMysql.length) {
    const missing = [...missingProxy, ...missingMysql].join(', ');
    throw new Error(`proxy-service/.env is missing release-critical keys: ${missing}`);
  }

  fs.writeFileSync(dst, renderEnv(entries), 'utf8');
  process.stdout.write(`✅ Bundled release env: ${dst}\n`);
  process.stdout.write(`   Included keys: ${entries.map((entry) => entry.key).join(', ')}\n`);
}

main();
