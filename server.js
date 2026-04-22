const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const dns = require('dns');
const net = require('net');

const { parseSubscriptionToNodes } = require('./decode-sub');
let YAML = null;
try {
  // Optional dependency for YAML file import (Clash config).
  // eslint-disable-next-line global-require
  YAML = require('yaml');
} catch {
  YAML = null;
}

function isElectronRuntime() {
  return Boolean(process.versions && process.versions.electron);
}

function getUserDataDir() {
  if (!isElectronRuntime()) return null;
  try {
    const { app } = require('electron');
    if (app && typeof app.isReady === 'function' && !app.isReady()) return null;
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch {
    // ignore
  }
  return null;
}

function configEnvHintPath() {
  const userData = getUserDataDir();
  if (userData) return path.join(userData, '.env');
  return path.join(__dirname, '.env');
}

let ENV_LOADED_FROM = null;

function bundledEnvCandidates() {
  const out = [];
  // When packaged, build/** is typically unpacked into:
  // <resources>/app.asar.unpacked/build/bundled.env
  try {
    const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
    if (resources) {
      out.push(path.join(resources, 'app.asar.unpacked', 'build', 'bundled.env'));
      out.push(path.join(resources, 'build', 'bundled.env'));
    }
  } catch {
    // ignore
  }
  // Dev / unpacked fallback
  out.push(path.join(__dirname, 'build', 'bundled.env'));
  return out;
}

try {
  // Load .env if present (admin machine friendly).
  // Prefer <userData>/.env (runtime override), then bundled.env (from build time), then proxy-service/.env in dev.
  const candidates = [];
  const userData = getUserDataDir();
  if (userData) candidates.push(path.join(userData, '.env'));
  candidates.push(...bundledEnvCandidates());
  candidates.push(path.join(__dirname, '.env'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        require('dotenv').config({ path: p, override: false });
        ENV_LOADED_FROM = p;
        break;
      }
    } catch {
      // ignore
    }
  }
} catch {
  // ignore
}

const PORT = Number(process.env.PROXY_SERVICE_PORT || 3123);
// Default to LAN-accessible (admin machine in intranet).
const HOST = process.env.PROXY_SERVICE_HOST || '0.0.0.0';

const RUNTIME = {
  host: HOST,
  port: PORT,
  actualPort: null,
  baseUrl: null,
  lanUrls: [],
  startedAt: null,
};

const DEFAULT_DATA_DIR = (() => {
  const userData = getUserDataDir();
  if (userData) return path.join(userData, 'data');
  return path.join(__dirname, 'data');
})();
const DATA_DIR = process.env.PROXY_SERVICE_DATA_DIR ? path.resolve(process.env.PROXY_SERVICE_DATA_DIR) : DEFAULT_DATA_DIR;
const STORE_PATH = process.env.PROXY_SERVICE_STORE
  ? path.resolve(process.env.PROXY_SERVICE_STORE)
  : path.join(DATA_DIR, 'proxies.json');

const ACCOUNTS_DIR = process.env.PROXY_SERVICE_ACCOUNTS_DIR
  ? path.resolve(process.env.PROXY_SERVICE_ACCOUNTS_DIR)
  : (() => {
      const userData = getUserDataDir();
      if (userData) return path.join(userData, 'accounts');
      return path.join(__dirname, 'accounts');
    })();

const ADMIN_COOKIE_NAME = 'fma_admin_session';
const ADMIN_SESSION_TTL_SEC = Number(process.env.PROXY_ADMIN_SESSION_TTL_SEC || 60 * 60 * 12); // 12h
const ADMIN_COOKIE_SECURE = String(process.env.PROXY_ADMIN_COOKIE_SECURE || '').trim() === '1';
const ADMIN_COOKIE_PERSIST = String(process.env.PROXY_ADMIN_COOKIE_PERSIST || '').trim() === '1';

// Activation codes default TTL: 1 day (no server-side config).
const ACTIVATION_CODE_TTL_SEC_DEFAULT = 60 * 60 * 24; // 1d

let ADMIN_PASSWORD = String(process.env.PROXY_ADMIN_PASSWORD || '').trim();
let ADMIN_SESSION_SECRET = String(process.env.PROXY_ADMIN_SESSION_SECRET || '').trim();
const ADMIN_PASSWORD_SOURCE = ADMIN_PASSWORD ? 'env' : 'generated';

if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(12).toString('base64url');
  try {
    process.env.PROXY_ADMIN_PASSWORD = ADMIN_PASSWORD;
  } catch {
    // ignore
  }
  console.log('🔐 PROXY_ADMIN_PASSWORD 未设置：已生成临时管理员密码（重启会变）：', ADMIN_PASSWORD);
}
if (!ADMIN_SESSION_SECRET) {
  ADMIN_SESSION_SECRET = crypto.randomBytes(32).toString('base64url');
  console.log('🔐 PROXY_ADMIN_SESSION_SECRET 未设置：已生成临时 session secret（重启会导致登录失效）');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function pad3(n) {
  return String(n).padStart(3, '0');
}

// Always use China timezone (UTC+08:00) for server timestamps, regardless of host machine timezone.
function toChinaIso(ms) {
  const t = Number(ms);
  const base = Number.isFinite(t) ? t : Date.now();
  const d = new Date(base + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const sss = pad3(d.getUTCMilliseconds());
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}.${sss}+08:00`;
}

function nowIso() {
  return toChinaIso(Date.now());
}

function addSecondsIso(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const t = Date.now() + Math.floor(s) * 1000;
  return toChinaIso(t);
}

function isExpiredIso(expiresAt) {
  if (!expiresAt) return false;
  const t = Date.parse(String(expiresAt));
  if (!Number.isFinite(t)) return false;
  return t <= Date.now();
}

function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signHmac(input) {
  return base64url(crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(String(input)).digest());
}

function signAdminSession(payload) {
  const body = base64url(JSON.stringify(payload));
  const sig = signHmac(body);
  return `${body}.${sig}`;
}

function verifyAdminSession(token) {
  const raw = String(token || '').trim();
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.', 2);
  if (!body || !sig) return null;
  const expected = signHmac(body);
  if (!timingSafeEqualStr(sig, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) return null;
  if (payload.typ !== 'admin') return null;
  return payload;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getAdminSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_COOKIE_NAME];
  return verifyAdminSession(token);
}

function setAdminCookie(res, token) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  // Default to session cookie (expires when browser closes).
  // Set PROXY_ADMIN_COOKIE_PERSIST=1 to persist across restarts.
  if (ADMIN_COOKIE_PERSIST) parts.push(`Max-Age=${Math.max(60, ADMIN_SESSION_TTL_SEC)}`);
  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearAdminCookie(res) {
  const parts = [
    `${ADMIN_COOKIE_NAME}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (ADMIN_COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function isApiRequest(req) {
  if (String(req.path || '').startsWith('/v1/')) return true;
  const accept = String(req.headers.accept || '');
  if (accept.includes('application/json')) return true;
  if (String(req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest') return true;
  return false;
}

function ensureStore() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ version: 1, updatedAt: nowIso(), profiles: {}, pool: [] }, null, 2),
    );
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { version: 1, profiles: {}, pool: [], nodes: [] };
    if (!data.profiles || typeof data.profiles !== 'object') data.profiles = {};
    if (!Array.isArray(data.pool)) data.pool = [];
    if (!Array.isArray(data.nodes)) data.nodes = [];
    return data;
  } catch {
    return { version: 1, profiles: {}, pool: [], nodes: [] };
  }
}

function writeStore(next) {
  ensureStore();
  const payload = {
    version: 1,
    updatedAt: nowIso(),
    profiles: next.profiles || {},
    pool: Array.isArray(next.pool) ? next.pool : [],
    nodes: Array.isArray(next.nodes) ? next.nodes : [],
    activationCodes: Array.isArray(next.activationCodes) ? next.activationCodes : [],
    machines: next.machines && typeof next.machines === 'object' ? next.machines : {},
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

function sanitizeName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) throw new Error('profile required');
  if (cleaned.length > 80) throw new Error('profile too long');
  if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('..')) throw new Error('invalid profile');
  return cleaned;
}

function normalizeProxy(input) {
  if (input == null) return null;

  // Accept:
  // - "ip:port" or "host:port"
  // - "ip:port:username:password"
  // - "user:password@host:port"
  // - "http://host:port" / "socks5://host:port"
  // - { server, username, password }
  // - { host, port, protocol, username, password }
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;

    // Standard URL (may include credentials)
    if (s.includes('://')) {
      try {
        const u = new URL(s);
        const server = `${u.protocol}//${u.host}`;
        const out = { server };
        if (u.username) out.username = decodeURIComponent(u.username);
        if (u.password) out.password = decodeURIComponent(u.password);
        return out;
      } catch {
        // fall through to other parsing
      }
    }

    // Support "host:port:username:password" (password may contain ':')
    // This is a common proxy vendor format.
    if (!s.includes('://')) {
      const parts = s.split(':');
      if (parts.length >= 4) {
        const host = parts[0].trim();
        const port = Number(parts[1]);
        const username = parts[2];
        const password = parts.slice(3).join(':');
        if (host && Number.isFinite(port) && port > 0) {
          return {
            server: `http://${host}:${port}`,
            username,
            password,
          };
        }
      }
    }

    // Support "user:password@host:port" (password may contain ':')
    if (!s.includes('://') && s.includes('@')) {
      const [cred, hostport] = s.split('@');
      if (cred && hostport && hostport.includes(':') && cred.includes(':')) {
        const cParts = cred.split(':');
        const username = cParts[0];
        const password = cParts.slice(1).join(':');
        const hpParts = hostport.split(':');
        const host = hpParts[0].trim();
        const port = Number(hpParts[1]);
        if (host && Number.isFinite(port) && port > 0) {
          return { server: `http://${host}:${port}`, username, password };
        }
      }
    }

    const server = `http://${s}`;
    return { server };
  }

  if (typeof input === 'object') {
    if (typeof input.server === 'string' && input.server.trim()) {
      const server = input.server.trim();
      const out = { server: server.includes('://') ? server : `http://${server}` };
      if (typeof input.username === 'string') out.username = input.username;
      if (typeof input.password === 'string') out.password = input.password;
      return out;
    }

    // common vendor object formats
    const ip = typeof input.ip === 'string' ? input.ip.trim() : '';
    const portNum = input.port != null ? Number(input.port) : NaN;
    if (ip && Number.isFinite(portNum) && portNum > 0) {
      const proto = typeof input.protocol === 'string' ? input.protocol.trim() : 'http';
      const out = { server: `${proto}://${ip}:${portNum}` };
      const user = typeof input.user === 'string' ? input.user : input.username;
      const pass = typeof input.pass === 'string' ? input.pass : input.password;
      if (typeof user === 'string') out.username = user;
      if (typeof pass === 'string') out.password = pass;
      return out;
    }

    const host = typeof input.host === 'string' ? input.host.trim() : '';
    const port = Number(input.port);
    if (host && Number.isFinite(port) && port > 0) {
      const proto = typeof input.protocol === 'string' ? input.protocol.trim() : 'http';
      const out = { server: `${proto}://${host}:${port}` };
      if (typeof input.username === 'string') out.username = input.username;
      if (typeof input.password === 'string') out.password = input.password;
      return out;
    }
  }

  return null;
}

function isNodeLink(link) {
  const s = String(link || '').trim();
  return s.startsWith('vless://') || s.startsWith('hysteria2://') || s.startsWith('vmess://');
}

function poolItemKind(it) {
  const k = String(it?.kind || '').trim().toLowerCase();
  if (k === 'proxy') return 'proxy';
  if (k === 'node') return 'node';
  if (it && typeof it === 'object') {
    if (it.proxy) return 'proxy';
    if (it.node) return 'node';
  }
  return null;
}

function poolItemProxyKey(proxy) {
  if (!proxy || typeof proxy !== 'object') return null;
  const server = typeof proxy.server === 'string' ? proxy.server.trim() : '';
  if (!server) return null;
  const username = typeof proxy.username === 'string' ? proxy.username : '';
  const password = typeof proxy.password === 'string' ? proxy.password : '';
  return `${server}::${username}::${password}`;
}

function poolItemNodeLink(node) {
  if (!node) return null;
  if (typeof node === 'string') {
    const s = node.trim();
    return isNodeLink(s) ? s : null;
  }
  if (typeof node === 'object') {
    const s = typeof node.fullLink === 'string' ? node.fullLink.trim() : '';
    return isNodeLink(s) ? s : null;
  }
  return null;
}

function serializeNodeForPool(node) {
  if (!node || typeof node !== 'object') return null;
  const fullLink = typeof node.fullLink === 'string' ? node.fullLink.trim() : '';
  if (!isNodeLink(fullLink)) return null;

  return {
    protocol: typeof node.protocol === 'string' ? node.protocol : '',
    host: typeof node.host === 'string' ? node.host : '',
    port: node.port != null ? String(node.port) : '',
    uuid: typeof node.uuid === 'string' ? node.uuid : '',
    // For hysteria2, "password" is required; for vless it may be empty (uuid is used).
    password: typeof node.password === 'string' ? node.password : '',
    remark: typeof node.remark === 'string' ? node.remark : '',
    title: typeof node.title === 'string' ? node.title : '',
    country: typeof node.country === 'string' ? node.country : '',
    type: typeof node.type === 'string' ? node.type : '',
    tls: node.tls === true,
    peer: typeof node.peer === 'string' ? node.peer : '',
    alpn: typeof node.alpn === 'string' ? node.alpn : '',
    obfs: typeof node.obfs === 'string' ? node.obfs : '',
    obfsParam: typeof node.obfsParam === 'string' ? node.obfsParam : '',
    path: typeof node.path === 'string' ? node.path : '',
    fullLink,
  };
}

function listPoolItems(store) {
  const pool = Array.isArray(store.pool) ? store.pool : [];
  return pool.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && (x.proxy || x.node));
}

function sanitizePoolPolicyItems(items) {
  const raw = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    let poolItemId = '';
    let priority = 0;
    if (typeof it === 'string') {
      poolItemId = it.trim();
      priority = 0;
    } else if (it && typeof it === 'object') {
      poolItemId = String(it.poolItemId || it.id || '').trim();
      const p = it.priority != null ? Number(it.priority) : 0;
      priority = Number.isFinite(p) ? Math.floor(p) : 0;
    }
    if (!poolItemId || poolItemId.length > 200) continue;
    if (seen.has(poolItemId)) continue;
    seen.add(poolItemId);
    const clamped = Math.min(999, Math.max(0, priority));
    out.push({ poolItemId, priority: clamped });
  }
  return out;
}

function getProfilePoolPolicy(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const policy = entry.poolPolicy && typeof entry.poolPolicy === 'object' ? entry.poolPolicy : null;
  const items = sanitizePoolPolicyItems(policy?.items);
  if (!items.length) return null;
  const stickyPoolItemId = typeof policy?.stickyPoolItemId === 'string' ? policy.stickyPoolItemId.trim() : '';
  const stickyAt = typeof policy?.stickyAt === 'string' ? policy.stickyAt : null;
  const updatedAt = typeof policy?.updatedAt === 'string' ? policy.updatedAt : null;
  return { items, stickyPoolItemId: stickyPoolItemId || null, stickyAt, updatedAt };
}

function policyAvailability(policy, poolById) {
  const items = policy && Array.isArray(policy.items) ? policy.items : [];
  let missing = 0;
  let disabled = 0;
  let unusable = 0;

  for (const x of items) {
    const poolItemId = x && typeof x === 'object' ? String(x.poolItemId || '').trim() : '';
    if (!poolItemId) continue;
    const it = poolById.get(poolItemId) || null;
    if (!it) {
      missing += 1;
      continue;
    }
    if (it.enabled === false) disabled += 1;
    if (poolItemKind(it) === 'node' && !poolItemNodeLink(it.node)) unusable += 1;
  }

  return { missing, disabled, unusable };
}

function listNodeItems(store) {
  const nodes = Array.isArray(store.nodes) ? store.nodes : [];
  return nodes.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.fullLink);
}

function removePoolItemsByPredicate(store, shouldRemove) {
  const pool = Array.isArray(store.pool) ? store.pool : [];
  const kept = [];
  const removed = [];

  for (const it of pool) {
    if (it && typeof it === 'object' && shouldRemove(it)) removed.push(it);
    else kept.push(it);
  }

  if (!removed.length) return { removedIds: [], removedItems: [] };
  store.pool = kept;
  return {
    removedIds: removed.map((x) => String(x?.id || '').trim()).filter(Boolean),
    removedItems: removed,
  };
}

function pruneProfilePoliciesReferencingPoolIds(store, removedIds) {
  const ids = Array.isArray(removedIds) ? removedIds.map((s) => String(s || '').trim()).filter(Boolean) : [];
  const uniq = Array.from(new Set(ids));
  if (!uniq.length) return { affectedProfiles: [], removedRefs: 0, deletedPolicies: 0 };

  const removed = new Set(uniq);
  store.profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
  const profiles = store.profiles;

  const affectedProfiles = [];
  let removedRefs = 0;
  let deletedPolicies = 0;
  const updatedAt = nowIso();

  for (const profile of Object.keys(profiles)) {
    const entry = profiles[profile];
    if (!entry || typeof entry !== 'object') continue;

    const policyObj =
      entry.poolPolicy && typeof entry.poolPolicy === 'object' && Array.isArray(entry.poolPolicy.items)
        ? entry.poolPolicy
        : null;
    if (!policyObj) continue;

    const oldItems = sanitizePoolPolicyItems(policyObj.items);
    const nextItems = oldItems.filter((x) => !removed.has(x.poolItemId));
    const stickyPoolItemId = typeof policyObj.stickyPoolItemId === 'string' ? policyObj.stickyPoolItemId.trim() : '';
    const stickyRemoved = stickyPoolItemId && removed.has(stickyPoolItemId);

    if (nextItems.length === oldItems.length && !stickyRemoved) continue;

    removedRefs += oldItems.length - nextItems.length;
    affectedProfiles.push(profile);

    if (!nextItems.length) {
      delete entry.poolPolicy;
      deletedPolicies += 1;
    } else {
      entry.poolPolicy = {
        ...(policyObj && typeof policyObj === 'object' ? policyObj : {}),
        items: nextItems,
        updatedAt,
        stickyPoolItemId: null,
        stickyAt: null,
      };
    }

    // If profile entry no longer has anything meaningful, remove it entirely.
    const hasStaticProxy = !!normalizeProxy(entry?.proxy ?? entry);
    const remainingKeys = Object.keys(entry || {}).filter((k) => !['updatedAt'].includes(k));
    if (!hasStaticProxy && remainingKeys.length === 0) {
      delete profiles[profile];
    } else {
      profiles[profile] = entry;
    }
  }

  store.profiles = profiles;
  return { affectedProfiles, removedRefs, deletedPolicies };
}

function clampString(s, maxLen) {
  const v = String(s || '').trim();
  if (!v) return '';
  if (v.length <= maxLen) return v;
  return v.slice(0, maxLen);
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function clashProxyToShareLink(proxy) {
  const p = proxy && typeof proxy === 'object' ? proxy : null;
  if (!p) return null;
  const type = String(p.type || '').trim().toLowerCase();
  const name = clampString(p.name || p.title || '', 180) || '节点';
  const host = clampString(p.server || p.host || '', 360);
  const portNum = p.port != null ? Number(p.port) : NaN;
  const port = Number.isFinite(portNum) && portNum > 0 ? Math.floor(portNum) : 0;
  if (!host || !port) return null;

  const params = new URLSearchParams();

  if (type === 'vmess') {
    const uuid = clampString(p.uuid || p.id || '', 120);
    if (!uuid) return null;

    const alterIdNum = p.alterId != null ? Number(p.alterId) : NaN;
    const aid = Number.isFinite(alterIdNum) ? String(Math.max(0, Math.floor(alterIdNum))) : '0';
    const cipher = clampString(p.cipher || p.method || 'auto', 40) || 'auto';

    const network = String(p.network || '').trim().toLowerCase() || 'tcp';
    const ws = p['ws-opts'] && typeof p['ws-opts'] === 'object' ? p['ws-opts'] : null;
    const grpc = p['grpc-opts'] && typeof p['grpc-opts'] === 'object' ? p['grpc-opts'] : null;

    // V2RayN vmess share json fields.
    const obj = {
      v: '2',
      ps: name,
      add: host,
      port: String(port),
      id: uuid,
      aid,
      scy: cipher,
      net: network,
      type: 'none',
      host: '',
      path: '',
      tls: p.tls === true ? 'tls' : '',
      sni: clampString(p.servername || p.sni || '', 240),
      alpn: '',
    };

    if (network === 'ws') {
      obj.path = clampString(ws?.path || '', 500);
      const headers = ws?.headers && typeof ws.headers === 'object' ? ws.headers : null;
      obj.host = clampString(headers?.Host || headers?.host || '', 360);
    } else if (network === 'grpc') {
      obj.path = clampString(grpc?.['grpc-service-name'] || grpc?.serviceName || grpc?.service || '', 160);
    }

    // Strip empty optional fields for smaller output.
    for (const k of Object.keys(obj)) {
      if (obj[k] == null) delete obj[k];
      else if (typeof obj[k] === 'string' && obj[k] === '') delete obj[k];
    }

    const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
    return `vmess://${b64}`;
  }

  if (type === 'vless') {
    const uuid = clampString(p.uuid || p.id || '', 120);
    if (!uuid) return null;

    const sni = clampString(p.servername || p.sni || '', 240);
    if (sni) params.set('sni', sni);

    const skipVerify = p['skip-cert-verify'] === true || p.skipCertVerify === true;
    if (skipVerify) params.set('insecure', '1');

    const alpn = p.alpn;
    if (typeof alpn === 'string' && alpn.trim()) params.set('alpn', alpn.trim());
    else if (Array.isArray(alpn) && alpn.length) {
      const joined = alpn.map((x) => String(x || '').trim()).filter(Boolean).join(',');
      if (joined) params.set('alpn', joined);
    }

    const flow = clampString(p.flow || '', 80);
    if (flow) params.set('flow', flow);

    const clientFp = clampString(p['client-fingerprint'] || p.clientFingerprint || p.fingerprint || '', 80);
    if (clientFp) params.set('fp', clientFp);

    const reality = p['reality-opts'] && typeof p['reality-opts'] === 'object' ? p['reality-opts'] : null;
    const pbk = clampString(
      reality?.['public-key'] || reality?.publicKey || reality?.public_key || reality?.pbk || '',
      260,
    );
    const sid = clampString(reality?.['short-id'] || reality?.shortId || reality?.short_id || reality?.sid || '', 80);
    const spx = clampString(
      reality?.['spider-x'] || reality?.spiderX || reality?.spider_x || reality?.spx || '',
      260,
    );

    // Clash Reality (VLESS + TLS + reality-opts). Encode into vless:// query params that sing-box can understand.
    // - security=reality + pbk/sid/spx + fp + flow (+ sni)
    // Fallback to plain TLS if tls: true.
    if (pbk || sid || spx) {
      params.set('security', 'reality');
      if (pbk) params.set('pbk', pbk);
      if (sid) params.set('sid', sid);
      if (spx) params.set('spx', spx);
    } else if (p.tls === true) {
      params.set('security', 'tls');
    }

    const network = String(p.network || '').trim().toLowerCase();
    if (network === 'ws') {
      params.set('type', 'ws');
      const ws = p['ws-opts'] && typeof p['ws-opts'] === 'object' ? p['ws-opts'] : null;
      const pathVal = clampString(ws?.path || '', 500);
      if (pathVal) params.set('path', pathVal);
      const headers = ws?.headers && typeof ws.headers === 'object' ? ws.headers : null;
      const wsHost = clampString(headers?.Host || headers?.host || '', 360);
      if (wsHost) params.set('host', wsHost);
    } else if (network === 'grpc') {
      params.set('type', 'grpc');
      const grpc = p['grpc-opts'] && typeof p['grpc-opts'] === 'object' ? p['grpc-opts'] : null;
      const svc = clampString(grpc?.['grpc-service-name'] || grpc?.serviceName || grpc?.service || '', 160);
      if (svc) params.set('serviceName', svc);
    }

    const q = params.toString();
    const hash = encodeURIComponent(name);
    return `vless://${encodeURIComponent(uuid)}@${host}:${port}${q ? `?${q}` : ''}#${hash}`;
  }

  if (type === 'hysteria2') {
    const password = clampString(p.password || p.auth || p['auth-str'] || '', 240);
    if (!password) return null;

    const sni = clampString(p.sni || p.servername || '', 240);
    if (sni) params.set('sni', sni);

    const alpn = p.alpn;
    if (typeof alpn === 'string' && alpn.trim()) params.set('alpn', alpn.trim());
    else if (Array.isArray(alpn) && alpn.length) {
      const joined = alpn.map((x) => String(x || '').trim()).filter(Boolean).join(',');
      if (joined) params.set('alpn', joined);
    }

    const q = params.toString();
    const hash = encodeURIComponent(name);
    return `hysteria2://${encodeURIComponent(password)}@${host}:${port}${q ? `?${q}` : ''}#${hash}`;
  }

  return null;
}

function parseClashYamlToNodeLinks(text) {
  if (!YAML) throw new Error('missing dependency: yaml');
  // Some exported .txt/.yaml files may include an UTF-8 BOM.
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return { links: [], totalProxies: 0, skipped: 0, skippedTypes: {} };
  const doc = YAML.parse(raw);
  // Accept both:
  // 1) Full Clash config: { proxies: [...] }
  // 2) Proxies-only YAML: [ ... ]
  const proxiesRaw = Array.isArray(doc) ? doc : doc && typeof doc === 'object' ? doc.proxies : [];
  const proxies = safeArray(proxiesRaw);
  const skippedTypes = {};
  const links = [];

  for (const pr of proxies) {
    const type = String(pr?.type || '').trim().toLowerCase() || 'unknown';
    const link = clashProxyToShareLink(pr);
    if (!link) {
      skippedTypes[type] = (skippedTypes[type] || 0) + 1;
      continue;
    }
    links.push(link);
  }

  const skipped = proxies.length - links.length;
  return { links, totalProxies: proxies.length, skipped, skippedTypes };
}

function parseProxyLines(text) {
  return String(text || '')
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function pickRandomEnabled(pool) {
  const enabled = pool.filter((x) => x && x.enabled !== false);
  if (!enabled.length) return null;

  // Prefer pool items that previously passed the check (proxy check or node reachability check).
  const ok = enabled.filter((x) => x.lastCheckOk === true);
  const candidates = ok.length ? ok : enabled;

  // Prefer ports that are less likely to be blocked by Chromium "unsafe port" rules.
  // Vendors sometimes return proxies on 444/445 which can break in Chromium even if curl works.
  const avoidPorts = String(process.env.PROXY_POOL_AVOID_PORTS || '444,445')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const avoid = new Set(avoidPorts);

  function portOf(item) {
    const s = String(item?.proxy?.server || '').trim();
    if (!s) return null;
    try {
      const u = new URL(s);
      const p = u.port ? Number(u.port) : null;
      return Number.isFinite(p) && p > 0 ? p : null;
    } catch {
      const m = s.match(/:(\d+)\b/);
      if (!m) return null;
      const p = Number(m[1]);
      return Number.isFinite(p) && p > 0 ? p : null;
    }
  }

  const preferred = enabled.filter((it) => {
    const p = portOf(it);
    if (!p) return true;
    return !avoid.has(p);
  });

  const preferred2 = candidates.filter((it) => {
    const p = portOf(it);
    if (!p) return true;
    return !avoid.has(p);
  });

  const list = preferred2.length ? preferred2 : candidates.length ? candidates : preferred.length ? preferred : enabled;
  return list[Math.floor(Math.random() * list.length)];
}

function pickRandomEnabledNode(nodes) {
  const enabled = nodes.filter((x) => x && x.enabled !== false);
  if (!enabled.length) return null;

  // Prefer nodes that previously passed the basic reachability check.
  const ok = enabled.filter((x) => x.lastCheckOk === true);
  const list = ok.length ? ok : enabled;
  return list[Math.floor(Math.random() * list.length)];
}

function sanitizeHttpUrl(urlRaw) {
  const s = String(urlRaw || '').trim();
  if (!s) throw new Error('url required');
  if (s.length > 2000) throw new Error('url too long');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('invalid url');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http/https is allowed');
  return u.toString();
}

function getPoolCheckDefaults() {
  const urlRaw =
    String(process.env.PROXY_POOL_CHECK_URL || '').trim() || 'https://labs.google/fx/tools/flow/';
  const methodRaw = String(process.env.PROXY_POOL_CHECK_METHOD || '').trim().toUpperCase() || 'GET';
  const method = ['GET', 'HEAD'].includes(methodRaw) ? methodRaw : 'GET';
  const timeoutRaw = process.env.PROXY_POOL_CHECK_TIMEOUT_MS;
  const timeoutMsParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;
  const timeoutMs = Number.isFinite(timeoutMsParsed) ? timeoutMsParsed : 6500;
  const clamped = Math.min(60000, Math.max(500, Math.floor(timeoutMs)));
  return { url: urlRaw, method, timeoutMs: clamped };
}

function getNodeCheckDefaults() {
  const timeoutRaw = process.env.PROXY_NODES_CHECK_TIMEOUT_MS;
  const timeoutMsParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;
  const timeoutMs = Number.isFinite(timeoutMsParsed) ? timeoutMsParsed : 3500;
  const clamped = Math.min(60000, Math.max(500, Math.floor(timeoutMs)));
  return { timeoutMs: clamped };
}

function sleepMs(ms) {
  const n = Number(ms);
  const clamped = Number.isFinite(n) ? Math.min(60_000, Math.max(0, Math.floor(n))) : 0;
  return new Promise((r) => setTimeout(r, clamped));
}

function isPoolAutoCheckEnabled() {
  const raw = String(process.env.PROXY_POOL_AUTOCHECK || '').trim().toLowerCase();
  if (!raw) return true; // default on
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  return true;
}

function getPoolNodeAutoToggleDefaults() {
  const intervalRaw = process.env.PROXY_POOL_NODE_AUTOTOGGLE_INTERVAL_MS;
  const intervalParsed = intervalRaw != null ? Number(intervalRaw) : NaN;
  const intervalMs = Number.isFinite(intervalParsed) ? intervalParsed : 180_000;
  const intervalClamped = Math.min(60 * 60 * 1000, Math.max(30_000, Math.floor(intervalMs)));

  const triesRaw = process.env.PROXY_POOL_NODE_AUTOTOGGLE_TRIES;
  const triesParsed = triesRaw != null ? Number(triesRaw) : NaN;
  const tries = Number.isFinite(triesParsed) ? Math.floor(triesParsed) : 3;
  const triesClamped = Math.min(5, Math.max(1, tries));

  const delayRaw = process.env.PROXY_POOL_NODE_AUTOTOGGLE_TRY_DELAY_MS;
  const delayParsed = delayRaw != null ? Number(delayRaw) : NaN;
  const delayMs = Number.isFinite(delayParsed) ? delayParsed : 400;
  const delayClamped = Math.min(15_000, Math.max(0, Math.floor(delayMs)));

  const defaults = getNodeCheckDefaults();
  const timeoutRaw = process.env.PROXY_POOL_NODE_AUTOTOGGLE_TIMEOUT_MS;
  const timeoutParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;
  const timeoutMs = Number.isFinite(timeoutParsed) ? timeoutParsed : defaults.timeoutMs;
  const timeoutClamped = Math.min(60_000, Math.max(500, Math.floor(timeoutMs)));

  return { intervalMs: intervalClamped, tries: triesClamped, tryDelayMs: delayClamped, timeoutMs: timeoutClamped };
}

function withTimeout(promise, timeoutMs, label) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let t = null;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`timeout ${ms}ms${label ? ` (${label})` : ''}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function dnsLookup(host, timeoutMs) {
  const h = String(host || '').trim();
  if (!h) throw new Error('host required');
  const r = await withTimeout(dns.promises.lookup(h, { all: false }), timeoutMs, 'dns');
  if (!r || !r.address) throw new Error('dns failed');
  return String(r.address);
}

async function tcpConnect(host, port, timeoutMs) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) throw new Error('invalid port');
  const h = String(host || '').trim();
  if (!h) throw new Error('host required');

  return withTimeout(
    new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let done = false;

      function finish(err) {
        if (done) return;
        done = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve();
      }

      socket.once('error', (e) => finish(e));
      socket.connect({ host: h, port: p }, () => finish(null));
    }),
    timeoutMs,
    'tcp',
  );
}

function parseNodeTargetFromPoolItem(poolItem) {
  const link = poolItemNodeLink(poolItem?.node);
  if (!link) return null;

  const nodeObj = poolItem && typeof poolItem.node === 'object' ? poolItem.node : null;
  const protocol =
    typeof nodeObj?.protocol === 'string' && nodeObj.protocol.trim()
      ? nodeObj.protocol.trim()
      : link.startsWith('hysteria2://')
        ? 'hysteria2'
        : link.startsWith('vless://')
          ? 'vless'
          : '';

  let host = typeof nodeObj?.host === 'string' ? nodeObj.host.trim() : '';
  let portNum = nodeObj?.port != null ? Number(nodeObj.port) : NaN;
  if (!host || !Number.isFinite(portNum) || portNum <= 0) {
    try {
      const fake = link.startsWith('vless://')
        ? link.replace(/^vless:\/\//i, 'https://')
        : link.replace(/^hysteria2:\/\//i, 'https://');
      const u = new URL(fake);
      host = host || String(u.hostname || '').trim();
      portNum = Number.isFinite(portNum) && portNum > 0 ? portNum : u.port ? Number(u.port) : 443;
    } catch {
      // ignore
    }
  }
  if (!host) return null;
  if (!Number.isFinite(portNum) || portNum <= 0) portNum = 443;

  const checkType = protocol === 'hysteria2' ? 'dns' : 'tcp';
  return { link, protocol, host, port: portNum, checkType };
}

async function performNodeReachabilityCheck({ host, port, checkType, timeoutMs }) {
  const startedAt = Date.now();
  let ip = null;
  let success = false;
  let error = null;
  let detail = null;
  try {
    ip = await dnsLookup(host, timeoutMs);
    if (checkType === 'dns') {
      success = true;
      detail = `DNS ${ip}`;
    } else {
      await tcpConnect(ip || host, port, timeoutMs);
      success = true;
      detail = `TCP ${ip || host}:${port}`;
    }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    error = msg.slice(0, 280);
    detail = checkType === 'dns' ? `DNS failed` : `TCP failed`;
  }
  const ms = Date.now() - startedAt;
  return { ip, success, error, detail, ms };
}

let POOL_NODE_AUTOTOGGLE_TIMER = null;
let POOL_NODE_AUTOTOGGLE_RUNNING = false;
let POOL_NODE_AUTOTOGGLE_LAST = null;

function isPoolNodeAutoToggleLogEnabled() {
  const raw = String(process.env.PROXY_POOL_NODE_AUTOTOGGLE_LOG || '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  return true;
}

async function runPoolNodeAutoToggleOnce({ reason = 'interval' } = {}) {
  if (!isPoolAutoCheckEnabled()) return { ok: true, skipped: true, reason: 'disabled' };
  if (POOL_NODE_AUTOTOGGLE_RUNNING) return { ok: true, skipped: true, reason: 'busy' };

  POOL_NODE_AUTOTOGGLE_RUNNING = true;
  const startedAt = Date.now();
  const checkedAt = nowIso();

  let checkedNodes = 0;
  let stableOk = 0;
  let stableFail = 0;
  let mixed = 0;
  let enabledOn = 0;
  let enabledOff = 0;

  try {
    const cfg = getPoolNodeAutoToggleDefaults();
    const store = readStore();
    const pool = Array.isArray(store.pool) ? store.pool : [];
    let changed = false;

    for (let i = 0; i < pool.length; i++) {
      const it = pool[i];
      if (!it || typeof it !== 'object') continue;
      if (poolItemKind(it) !== 'node') continue;
      if (!poolItemNodeLink(it.node)) continue;

      const target = parseNodeTargetFromPoolItem(it);
      if (!target) continue;

      checkedNodes += 1;
      let okCount = 0;
      let failCount = 0;
      let last = null;

      for (let t = 0; t < cfg.tries; t++) {
        // eslint-disable-next-line no-await-in-loop
        last = await performNodeReachabilityCheck({
          host: target.host,
          port: target.port,
          checkType: target.checkType,
          timeoutMs: cfg.timeoutMs,
        });
        if (last && last.success) okCount += 1;
        else failCount += 1;

        if (t < cfg.tries - 1 && cfg.tryDelayMs > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sleepMs(cfg.tryDelayMs);
        }
      }

      const stable = okCount === cfg.tries ? 'ok' : failCount === cfg.tries ? 'fail' : 'mixed';
      if (stable === 'ok') stableOk += 1;
      else if (stable === 'fail') stableFail += 1;
      else mixed += 1;

      it.autoCheckAt = checkedAt;
      it.autoCheckKind = 'node';
      it.autoCheckType = target.checkType;
      it.autoCheckTimeoutMs = cfg.timeoutMs;
      it.autoCheckTries = cfg.tries;
      it.autoCheckOkCount = okCount;
      it.autoCheckFailCount = failCount;
      it.autoCheckStable = stable;
      it.autoCheckDetail =
        stable === 'mixed'
          ? `MIXED ok=${okCount}/${cfg.tries}`
          : last?.detail
            ? String(last.detail)
            : stable === 'ok'
              ? 'OK'
              : 'FAIL';
      it.autoCheckError = last?.error ? String(last.error) : '';
      it.autoCheckMs = last && typeof last.ms === 'number' ? last.ms : null;
      it.autoCheckIp = last?.ip || null;
      it.autoCheckReason = String(reason || '').slice(0, 40);

      // Also update the common pool "lastCheck*" fields so the UI shows the latest auto-check summary.
      it.lastCheckAt = checkedAt;
      it.lastCheckKind = 'node';
      it.lastCheckType = target.checkType;
      it.lastCheckTimeoutMs = cfg.timeoutMs;
      it.lastCheckMs = it.autoCheckMs;
      it.lastCheckOk = stable === 'ok' ? true : stable === 'fail' ? false : null;
      it.lastCheckIp = it.autoCheckIp;
      it.lastCheckDetail = it.autoCheckDetail;
      it.lastCheckError = it.autoCheckError;
      it.lastCheckUrl = null;
      it.lastCheckMethod = null;
      it.lastCheckHttpStatus = null;

      if (stable === 'ok' && it.enabled === false) {
        it.enabled = true;
        it.autoToggledAt = checkedAt;
        it.autoToggledTo = true;
        it.autoToggledReason = `stable ok ${okCount}/${cfg.tries}`;
        enabledOn += 1;
        changed = true;
      } else if (stable === 'fail' && it.enabled !== false) {
        it.enabled = false;
        it.autoToggledAt = checkedAt;
        it.autoToggledTo = false;
        it.autoToggledReason = `stable fail ${failCount}/${cfg.tries}`;
        enabledOff += 1;
        changed = true;
      }
    }

    if (changed) {
      store.pool = pool;
      writeStore(store);
    }

    const ms = Date.now() - startedAt;
    POOL_NODE_AUTOTOGGLE_LAST = {
      at: checkedAt,
      ms,
      checkedNodes,
      stableOk,
      stableFail,
      mixed,
      enabledOn,
      enabledOff,
    };

    if (isPoolNodeAutoToggleLogEnabled()) {
      console.log(
        `[pool:auto] nodes=${checkedNodes} ok=${stableOk} fail=${stableFail} mixed=${mixed} on=${enabledOn} off=${enabledOff} ms=${ms}`,
      );
    }

    return { ok: true, ...POOL_NODE_AUTOTOGGLE_LAST };
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    POOL_NODE_AUTOTOGGLE_LAST = { at: checkedAt, error: msg.slice(0, 280) };
    return { ok: false, error: POOL_NODE_AUTOTOGGLE_LAST.error };
  } finally {
    POOL_NODE_AUTOTOGGLE_RUNNING = false;
  }
}

function stopPoolNodeAutoToggleLoop() {
  if (!POOL_NODE_AUTOTOGGLE_TIMER) return;
  try {
    clearInterval(POOL_NODE_AUTOTOGGLE_TIMER);
  } catch {
    // ignore
  }
  POOL_NODE_AUTOTOGGLE_TIMER = null;
}

function startPoolNodeAutoToggleLoop(server) {
  if (!isPoolAutoCheckEnabled()) return;
  if (POOL_NODE_AUTOTOGGLE_TIMER) return;

  const cfg = getPoolNodeAutoToggleDefaults();
  const tick = () =>
    runPoolNodeAutoToggleOnce({ reason: 'timer' }).catch((e) => {
      if (isPoolNodeAutoToggleLogEnabled()) {
        console.warn('[pool:auto] tick failed:', e?.message || e);
      }
    });

  // Delay the first run slightly to avoid competing with startup work.
  const firstDelayMs = Math.min(30_000, Math.max(1000, Math.floor(cfg.tryDelayMs + 1000)));
  const first = setTimeout(tick, firstDelayMs);
  if (typeof first.unref === 'function') first.unref();

  POOL_NODE_AUTOTOGGLE_TIMER = setInterval(tick, cfg.intervalMs);
  if (typeof POOL_NODE_AUTOTOGGLE_TIMER.unref === 'function') POOL_NODE_AUTOTOGGLE_TIMER.unref();

  if (server && typeof server.once === 'function') {
    server.once('close', () => stopPoolNodeAutoToggleLoop());
  }
}

function ensureAccountsDir() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  return ACCOUNTS_DIR;
}

function sanitizeProfileName(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) throw new Error('profile required');
  if (cleaned.length > 80) throw new Error('profile too long');
  if (cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('..')) throw new Error('invalid profile');
  return cleaned;
}

function accountFilePath(profile) {
  const safe = sanitizeProfileName(profile);
  ensureAccountsDir();
  const filePath = path.join(ACCOUNTS_DIR, `${safe}.json`);
  const resolvedDir = path.resolve(ACCOUNTS_DIR) + path.sep;
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedDir)) throw new Error('invalid profile');
  return resolvedFilePath;
}

function listAccountProfiles() {
  ensureAccountsDir();
  const files = fs.readdirSync(ACCOUNTS_DIR).filter((f) => f.toLowerCase().endsWith('.json'));
  return files
    .map((f) => {
      const name = f.replace(/\.json$/i, '');
      const full = path.join(ACCOUNTS_DIR, f);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        stat = null;
      }
      return { name, size: stat?.size || 0, updatedAt: stat ? toChinaIso(stat.mtimeMs) : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function readAccountStorageState(profile) {
  const fp = accountFilePath(profile);
  const raw = fs.readFileSync(fp, 'utf8');
  return JSON.parse(raw);
}

function writeAccountStorageState(profile, storageState) {
  const fp = accountFilePath(profile);
  fs.writeFileSync(fp, JSON.stringify(storageState, null, 2));
  return fp;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function genActivationCode() {
  // Human-friendly, case-insensitive groups.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, I/1
  const rand = (n) => {
    let out = '';
    for (let i = 0; i < n; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  };
  return `FMA-${rand(4)}-${rand(4)}-${rand(4)}`;
}

function requireAdmin(req, res, next) {
  const s = getAdminSession(req);
  if (s) {
    req.adminSession = s;
    return next();
  }
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

function authClient(req, res, next) {
  const h = String(req.headers.authorization || '').trim();
  if (!h.toLowerCase().startsWith('bearer ')) return res.status(401).json({ ok: false, error: 'missing token' });
  const token = h.slice(7).trim();
  if (!token) return res.status(401).json({ ok: false, error: 'missing token' });
  const store = readStore();
  const tokenHash = sha256Hex(token);
  const machines = store.machines && typeof store.machines === 'object' ? store.machines : {};
  const machineId = Object.keys(machines).find((id) => machines[id] && machines[id].tokenHash === tokenHash);
  if (!machineId) return res.status(401).json({ ok: false, error: 'invalid token' });
  const m = machines[machineId];
  m.lastSeenAt = nowIso();
  store.machines = machines;
  writeStore(store);
  req.clientMachine = { machineId, ...m };
  return next();
}

function extractProxyCandidates(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object') return [];

  // Try common keys
  for (const k of ['data', 'list', 'items', 'result', 'rows']) {
    if (Array.isArray(data[k])) return data[k];
  }
  if (data.proxy != null) return [data.proxy];
  if (data.ip && data.port) return [data];
  return [];
}

function parseProxiesFromResponseBody(bodyText) {
  // Extract candidates from either JSON or plain text.
  // Returns normalized proxy objects [{server, username?, password?}, ...]
  const out = [];
  const push = (candidate) => {
    const p = normalizeProxy(candidate);
    if (p) out.push(p);
  };

  const text = String(bodyText || '').trim();
  if (!text) return out;

  // Attempt JSON first.
  try {
    const data = JSON.parse(text);
    const candidates = extractProxyCandidates(data);
    for (const c of candidates) {
      if (typeof c === 'string') push(c);
      else if (c && typeof c === 'object') {
        if (c.proxy != null) push(c.proxy);
        else if (c.server || c.host || (c.ip && c.port)) push(c);
        else if (c.IP && c.PORT) push({ ip: String(c.IP), port: Number(c.PORT), user: c.USER, pass: c.PASS });
      }
    }
    return out;
  } catch {
    // ignore
  }

  // Plain text: parse line-by-line; also try to extract tokens from mixed strings.
  const lines = parseProxyLines(text);
  for (const line of lines) push(line);

  // If the vendor returns JSON-ish but not valid JSON, try to extract proxy-like tokens.
  // Matches:
  // - host:port
  // - host:port:user:pass
  // - user:pass@host:port
  const tokenRe =
    /([a-zA-Z0-9.\-]+:\d{2,5}:[^ \t\r\n:@]+:[^ \t\r\n]+|[^ \t\r\n:@]+:[^ \t\r\n@]+@[a-zA-Z0-9.\-]+:\d{2,5}|[a-zA-Z0-9.\-]+:\d{2,5})/g;
  const tokens = text.match(tokenRe) || [];
  for (const t of tokens) push(t);

  return out;
}

async function fetchUpstreamProxy(profile) {
  // Framework hook:
  // If PROXY_UPSTREAM_URL is set, we will call it when a profile has no static mapping.
  // Expected upstream response (any of these shapes):
  // - { proxy: "ip:port" }
  // - { server: "http://ip:port", username, password }
  // - { proxy: { server, username, password } }
  const upstream = process.env.PROXY_UPSTREAM_URL;
  if (!upstream) return null;

  const url = new URL(upstream);
  url.searchParams.set('profile', profile);

  const timeoutMs = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS || 3500);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data) return null;
    const candidate = data.proxy ?? data;
    return normalizeProxy(candidate);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

// --- Auth (admin) ---
app.post('/auth/login', (req, res) => {
  const password = String(req.body?.password || '').trim();
  if (!password) return res.status(400).json({ ok: false, error: 'password required' });
  if (!timingSafeEqualStr(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'invalid password' });
  }
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.max(300, ADMIN_SESSION_TTL_SEC);
  const token = signAdminSession({ typ: 'admin', iat, exp });
  setAdminCookie(res, token);
  return res.json({ ok: true, exp });
});

app.post('/auth/logout', (_req, res) => {
  clearAdminCookie(res);
  return res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const s = getAdminSession(req);
  if (!s) return res.status(401).json({ ok: false, error: 'unauthorized' });
  return res.json({ ok: true, typ: 'admin', exp: s.exp || null });
});

// --- Gate (admin pages + admin APIs) ---
app.use((req, res, next) => {
  const p = String(req.path || '');

  // Public paths
  if (p === '/health') return next();
  if (p.startsWith('/auth/')) return next();
  if (p.startsWith('/v1/client/')) return next();
  if (p === '/login.html') return next();
  if (p === '/app.css') return next();
  if (p === '/nav.js') return next();
  if (p === '/pager.js') return next();
  if (p === '/favicon.ico') return next();

  const session = getAdminSession(req);
  if (session) return next();

  if (isApiRequest(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const nextUrl = encodeURIComponent(req.originalUrl || '/');
  return res.redirect(`/login.html?next=${nextUrl}`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    ts: nowIso(),
    host: RUNTIME.host,
    port: RUNTIME.port,
    actualPort: RUNTIME.actualPort,
    baseUrl: RUNTIME.baseUrl,
    lanUrls: RUNTIME.lanUrls,
    adminPasswordSource: ADMIN_PASSWORD_SOURCE,
    envLoadedFrom: ENV_LOADED_FROM,
    envHint: configEnvHintPath(),
    startedAt: RUNTIME.startedAt,
  }),
);

app.get('/v1/store', requireAdmin, (_req, res) => {
  const store = readStore();
  const poolCheck = getPoolCheckDefaults();
  const nodeCheck = getNodeCheckDefaults();
  const poolNodeAutoToggle = getPoolNodeAutoToggleDefaults();
  res.json({
    ok: true,
    storePath: STORE_PATH,
    version: store.version || 1,
    updatedAt: store.updatedAt || null,
    profiles: Object.keys(store.profiles || {}).sort(),
    poolSize: Array.isArray(store.pool) ? store.pool.length : 0,
    nodeSize: Array.isArray(store.nodes) ? store.nodes.length : 0,
    poolCheck,
    nodeCheck,
    poolAutoCheckEnabled: isPoolAutoCheckEnabled(),
    poolNodeAutoToggle,
    poolNodeAutoToggleStatus: {
      running: !!POOL_NODE_AUTOTOGGLE_TIMER,
      busy: !!POOL_NODE_AUTOTOGGLE_RUNNING,
      last: POOL_NODE_AUTOTOGGLE_LAST,
    },
    machines: store.machines ? Object.keys(store.machines).length : 0,
    accountsDir: ACCOUNTS_DIR,
  });
});

app.use('/v1/pool', requireAdmin);
app.use('/v1/proxy', requireAdmin);
app.use('/v1/nodes', requireAdmin);
app.use('/v1/proxy-policy', requireAdmin);

app.get('/v1/nodes', (_req, res) => {
  const store = readStore();
  const items = listNodeItems(store).sort((a, b) => {
    const ac = String(a.country || '');
    const bc = String(b.country || '');
    const r1 = String(a.remark || '');
    const r2 = String(b.remark || '');
    const c = ac.localeCompare(bc, 'zh-Hans-CN');
    if (c !== 0) return c;
    return r1.localeCompare(r2, 'zh-Hans-CN');
  });
  res.json({
    ok: true,
    storePath: STORE_PATH,
    updatedAt: store.updatedAt || null,
    items,
  });
});

app.post('/v1/nodes/fetch', async (req, res) => {
  const urlRaw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!urlRaw) return res.status(400).json({ ok: false, error: 'url required' });

  let url;
  try {
    url = new URL(urlRaw);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid url' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return res.status(400).json({ ok: false, error: 'only http/https is allowed' });
  }

  const timeoutMs = Number(process.env.PROXY_NODES_FETCH_TIMEOUT_MS || 8500);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  try {
    const r = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'text/plain,*/*' },
      signal: controller.signal,
    });
    text = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `upstream http ${r.status}`,
        upstreamStatus: r.status,
        sample: String(text || '').slice(0, 800),
      });
    }
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message || String(err);
    return res.status(502).json({ ok: false, error: `fetch failed: ${msg}` });
  } finally {
    clearTimeout(t);
  }

  const nodes = parseSubscriptionToNodes(text);
  if (!nodes.length) {
    return res.json({
      ok: true,
      added: 0,
      updated: 0,
      parsed: 0,
      sample: String(text || '').slice(0, 800),
    });
  }

  const store = readStore();
  const items = listNodeItems(store);

  const existing = new Map(items.map((x) => [String(x.fullLink), x]));
  const sourceLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const now = nowIso();
  let added = 0;
  let updated = 0;

  for (const n of nodes) {
    const fullLink = String(n?.fullLink || '').trim();
    if (!fullLink) continue;

    const prev = existing.get(fullLink);
    if (prev) {
      prev.protocol = n.protocol;
      prev.host = n.host;
      prev.port = n.port;
      prev.uuid = n.uuid;
      if ('password' in n) prev.password = n.password;
      prev.remark = n.remark;
      if ('title' in n) prev.title = n.title;
      prev.country = n.country;
      if ('type' in n) prev.type = n.type;
      if ('tls' in n) prev.tls = n.tls;
      if ('peer' in n) prev.peer = n.peer;
      if ('alpn' in n) prev.alpn = n.alpn;
      if ('obfs' in n) prev.obfs = n.obfs;
      if ('obfsParam' in n) prev.obfsParam = n.obfsParam;
      if ('path' in n) prev.path = n.path;
      prev.sourceUrl = url.toString();
      if (sourceLabel) prev.sourceLabel = sourceLabel;
      prev.lastSeenAt = now;
      prev.updatedAt = now;
      updated += 1;
      continue;
    }

    const it = {
      id: newId(),
      enabled: req.body?.enabled === false ? false : true,
      label: typeof req.body?.nodeLabel === 'string' ? req.body.nodeLabel.trim() : '',
      protocol: n.protocol,
      host: n.host,
      port: n.port,
      uuid: n.uuid,
      password: n.password || '',
      remark: n.remark,
      title: n.title || n.remark || '',
      country: n.country,
      type: n.type || '',
      tls: n.tls === true,
      peer: n.peer || '',
      alpn: n.alpn || '',
      obfs: n.obfs || '',
      obfsParam: n.obfsParam || '',
      path: n.path || '',
      fullLink,
      sourceUrl: url.toString(),
      sourceLabel,
      addedAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    items.push(it);
    existing.set(fullLink, it);
    added += 1;
  }

  store.nodes = items;
  const written = writeStore(store);
  return res.json({
    ok: true,
    added,
    updated,
    parsed: nodes.length,
    storeUpdatedAt: written.updatedAt,
  });
});

app.post('/v1/nodes/import', requireAdmin, (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
  const sourceLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const enabled = req.body?.enabled === false ? false : true;

  const maxBytes = 6 * 1024 * 1024;
  if (!content || !String(content).trim()) return res.status(400).json({ ok: false, error: 'content required' });
  if (Buffer.byteLength(content, 'utf8') > maxBytes) return res.status(413).json({ ok: false, error: 'file too large' });

  let linksInfo;
  try {
    linksInfo = parseClashYamlToNodeLinks(content);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    return res.status(400).json({ ok: false, error: `parse failed: ${msg}` });
  }

  const text = linksInfo.links.join('\n');
  const nodes = parseSubscriptionToNodes(text);
  if (!nodes.length) {
    return res.json({
      ok: true,
      added: 0,
      updated: 0,
      parsed: 0,
      totalProxies: linksInfo.totalProxies,
      skipped: linksInfo.skipped,
      skippedTypes: linksInfo.skippedTypes,
      filename: filename || null,
    });
  }

  const store = readStore();
  const items = listNodeItems(store);
  const existing = new Map(items.map((x) => [String(x.fullLink), x]));
  const now = nowIso();
  let added = 0;
  let updated = 0;

  for (const n of nodes) {
    const fullLink = String(n?.fullLink || '').trim();
    if (!fullLink) continue;

    const prev = existing.get(fullLink);
    if (prev) {
      prev.protocol = n.protocol;
      prev.host = n.host;
      prev.port = n.port;
      prev.uuid = n.uuid;
      if ('password' in n) prev.password = n.password;
      prev.remark = n.remark;
      if ('title' in n) prev.title = n.title;
      prev.country = n.country;
      if ('type' in n) prev.type = n.type;
      if ('tls' in n) prev.tls = n.tls;
      if ('peer' in n) prev.peer = n.peer;
      if ('alpn' in n) prev.alpn = n.alpn;
      if ('obfs' in n) prev.obfs = n.obfs;
      if ('obfsParam' in n) prev.obfsParam = n.obfsParam;
      if ('path' in n) prev.path = n.path;
      prev.sourceUrl = null;
      prev.sourceFile = filename || '';
      if (sourceLabel) prev.sourceLabel = sourceLabel;
      prev.lastSeenAt = now;
      prev.updatedAt = now;
      updated += 1;
      continue;
    }

    const it = {
      id: newId(),
      enabled,
      label: typeof req.body?.nodeLabel === 'string' ? req.body.nodeLabel.trim() : '',
      protocol: n.protocol,
      host: n.host,
      port: n.port,
      uuid: n.uuid,
      password: n.password || '',
      remark: n.remark,
      title: n.title || n.remark || '',
      country: n.country,
      type: n.type || '',
      tls: n.tls === true,
      peer: n.peer || '',
      alpn: n.alpn || '',
      obfs: n.obfs || '',
      obfsParam: n.obfsParam || '',
      path: n.path || '',
      fullLink,
      sourceUrl: null,
      sourceFile: filename || '',
      sourceLabel,
      addedAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    items.push(it);
    existing.set(fullLink, it);
    added += 1;
  }

  store.nodes = items;
  const written = writeStore(store);
  return res.json({
    ok: true,
    added,
    updated,
    parsed: nodes.length,
    totalProxies: linksInfo.totalProxies,
    skipped: linksInfo.skipped,
    skippedTypes: linksInfo.skippedTypes,
    filename: filename || null,
    storeUpdatedAt: written.updatedAt,
  });
});

app.put('/v1/nodes/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const items = listNodeItems(store);
  const idx = items.findIndex((x) => x && x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

  const it = items[idx];
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  const enabledTouched = !!(body && Object.prototype.hasOwnProperty.call(body, 'enabled'));
  if (req.body && typeof req.body === 'object') {
    if ('enabled' in req.body) it.enabled = req.body.enabled === false ? false : true;
    if (typeof req.body.label === 'string') it.label = req.body.label.trim();
  }
  it.updatedAt = nowIso();

  store.nodes = items;
  let cascade = null;
  if (enabledTouched && it.enabled === false) {
    const fullLink = typeof it.fullLink === 'string' ? it.fullLink.trim() : '';
    const removedPool = removePoolItemsByPredicate(store, (p) => {
      if (!p || typeof p !== 'object') return false;
      if (poolItemKind(p) !== 'node') return false;
      const byId = typeof p.nodeId === 'string' && p.nodeId.trim() ? p.nodeId.trim() : '';
      if (byId && byId === id) return true;
      const link = poolItemNodeLink(p.node);
      return fullLink && link === fullLink;
    });
    const pruned = pruneProfilePoliciesReferencingPoolIds(store, removedPool.removedIds);
    cascade = {
      reason: 'node_disabled',
      removedPoolItems: removedPool.removedIds.length,
      removedPoolItemIds: removedPool.removedIds,
      prunedProfiles: pruned.affectedProfiles,
      removedPolicyRefs: pruned.removedRefs,
      deletedPolicies: pruned.deletedPolicies,
    };
  }
  const written = writeStore(store);
  return res.json({ ok: true, item: it, cascade, storeUpdatedAt: written.updatedAt });
});

app.delete('/v1/nodes/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const items = listNodeItems(store);
  const idx = items.findIndex((x) => x && x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

  const removedNode = items[idx];
  const fullLink = typeof removedNode?.fullLink === 'string' ? removedNode.fullLink.trim() : '';
  items.splice(idx, 1);
  store.nodes = items;

  const removedPool = removePoolItemsByPredicate(store, (p) => {
    if (!p || typeof p !== 'object') return false;
    if (poolItemKind(p) !== 'node') return false;
    const byId = typeof p.nodeId === 'string' && p.nodeId.trim() ? p.nodeId.trim() : '';
    if (byId && byId === id) return true;
    const link = poolItemNodeLink(p.node);
    return fullLink && link === fullLink;
  });
  const pruned = pruneProfilePoliciesReferencingPoolIds(store, removedPool.removedIds);

  const written = writeStore(store);
  return res.json({
    ok: true,
    cascade: {
      reason: 'node_deleted',
      removedPoolItems: removedPool.removedIds.length,
      removedPoolItemIds: removedPool.removedIds,
      prunedProfiles: pruned.affectedProfiles,
      removedPolicyRefs: pruned.removedRefs,
      deletedPolicies: pruned.deletedPolicies,
    },
    storeUpdatedAt: written.updatedAt,
  });
});

app.post('/v1/nodes/:id/check', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const items = listNodeItems(store);
  const idx = items.findIndex((x) => x && x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

  const it = items[idx];
  const host = String(it.host || '').trim();
  const portNum = Number(it.port);
  if (!host) return res.status(400).json({ ok: false, error: 'invalid host' });
  if (!Number.isFinite(portNum) || portNum <= 0) return res.status(400).json({ ok: false, error: 'invalid port' });

  const defaults = getNodeCheckDefaults();
  const timeoutRaw = req.body?.timeoutMs;
  const timeoutMsParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;
  const timeoutMs = Number.isFinite(timeoutMsParsed)
    ? Math.min(60000, Math.max(500, Math.floor(timeoutMsParsed)))
    : defaults.timeoutMs;

  const protocol = String(it.protocol || '').trim();
  const checkType = protocol === 'hysteria2' ? 'dns' : 'tcp';
  const startedAt = Date.now();
  const checkedAt = nowIso();
  let ip = null;
  let success = false;
  let error = null;
  let detail = null;

  try {
    ip = await dnsLookup(host, timeoutMs);
    if (checkType === 'dns') {
      success = true;
      detail = `DNS ${ip}`;
    } else {
      await tcpConnect(ip || host, portNum, timeoutMs);
      success = true;
      detail = `TCP ${ip || host}:${portNum}`;
    }
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    error = msg.slice(0, 280);
    if (checkType === 'dns') detail = `DNS failed`;
    else detail = `TCP failed`;
  }

  const ms = Date.now() - startedAt;
  it.lastCheckAt = checkedAt;
  it.lastCheckType = checkType;
  it.lastCheckTimeoutMs = timeoutMs;
  it.lastCheckMs = ms;
  it.lastCheckOk = !!success;
  it.lastCheckIp = ip;
  it.lastCheckDetail = detail;
  it.lastCheckError = error || '';

  items[idx] = it;
  store.nodes = items;
  const written = writeStore(store);

  return res.json({
    ok: true,
    id,
    host,
    port: portNum,
    protocol: protocol || null,
    checkType,
    timeoutMs,
    ip,
    ms,
    success,
    detail,
    error: error || null,
    storeUpdatedAt: written.updatedAt,
    item: it,
  });
});

app.post('/v1/nodes/:id/to-pool', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const nodes = listNodeItems(store);
  const node = nodes.find((x) => x && x.id === id);
  if (!node) return res.status(404).json({ ok: false, error: 'node not found' });

  const nodePayload = serializeNodeForPool(node);
  if (!nodePayload) return res.status(400).json({ ok: false, error: 'bad node (missing fullLink)' });

  const pool = listPoolItems(store);
  const link = nodePayload.fullLink;
  const existingNodeLinks = new Set(
    pool
      .map((x) => poolItemNodeLink(x?.node))
      .filter(Boolean),
  );
  if (existingNodeLinks.has(link)) return res.json({ ok: true, added: 0, skipped: 1, parsed: 1, reason: 'duplicate' });

  const label =
    typeof req.body?.label === 'string'
      ? req.body.label.trim()
      : String(node.label || '').trim() || String(node.remark || '').trim() || '';

  // Keep disabled by default on add: node entries require client-side sing-box landing.
  const enabled = req.body?.enabled === true ? true : false;
  const it = {
    id: newId(),
    label,
    enabled,
    kind: 'node',
    nodeId: node.id,
    node: nodePayload,
    addedAt: nowIso(),
    lastUsedAt: null,
  };

  pool.push(it);
  store.pool = pool;
  const written = writeStore(store);
  return res.json({
    ok: true,
    added: 1,
    skipped: 0,
    parsed: 1,
    poolItemId: it.id,
    storeUpdatedAt: written.updatedAt,
  });
});

app.get('/v1/pool', (_req, res) => {
  const store = readStore();
  const items = listPoolItems(store);
  res.json({
    ok: true,
    storePath: STORE_PATH,
    updatedAt: store.updatedAt || null,
    items,
  });
});

app.get('/v1/pool/random', (_req, res) => {
  const store = readStore();
  const items = listPoolItems(store);
  const picked = pickRandomEnabled(items);
  if (!picked) return res.json({ ok: true, proxy: null, node: null, source: 'pool', item: null });
  picked.lastUsedAt = nowIso();
  store.pool = items;
  writeStore(store);
  const kind = poolItemKind(picked);
  if (kind === 'node') {
    return res.json({ ok: true, proxy: null, node: picked.node || null, source: 'pool', item: picked });
  }
  return res.json({ ok: true, proxy: picked.proxy || null, node: null, source: 'pool', item: picked });
});

app.post('/v1/pool/fetch', async (req, res) => {
  const urlRaw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!urlRaw) return res.status(400).json({ ok: false, error: 'url required' });

  let url;
  try {
    url = new URL(urlRaw);
  } catch {
    return res.status(400).json({ ok: false, error: 'invalid url' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return res.status(400).json({ ok: false, error: 'only http/https is allowed' });
  }

  const timeoutMs = Number(process.env.PROXY_FETCH_TIMEOUT_MS || 6500);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  try {
    const r = await fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json,text/plain,*/*' },
      signal: controller.signal,
    });
    text = await r.text();
    if (!r.ok) {
      return res.status(502).json({
        ok: false,
        error: `upstream http ${r.status}`,
        upstreamStatus: r.status,
        sample: String(text || '').slice(0, 800),
      });
    }
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : err.message || String(err);
    return res.status(502).json({ ok: false, error: `fetch failed: ${msg}` });
  } finally {
    clearTimeout(t);
  }

  const proxies = parseProxiesFromResponseBody(text);
  if (!proxies.length) {
    return res.json({
      ok: true,
      added: 0,
      skipped: 0,
      parsed: 0,
      sample: String(text || '').slice(0, 800),
    });
  }

  const store = readStore();
  const pool = listPoolItems(store);

  const key = (p) => poolItemProxyKey(p);
  const existing = new Set(pool.map((x) => key(x?.proxy)).filter(Boolean));
  const toAdd = proxies.map((proxy) => ({
    id: newId(),
    label: typeof req.body?.label === 'string' ? req.body.label.trim() : '',
    enabled: req.body?.enabled === false ? false : true,
    proxy,
    addedAt: nowIso(),
    lastUsedAt: null,
  }));

  let added = 0;
  let skipped = 0;
  for (const it of toAdd) {
    const k = key(it.proxy);
    if (existing.has(k)) {
      skipped += 1;
      continue;
    }
    existing.add(k);
    pool.push(it);
    added += 1;
  }
  store.pool = pool;
  const written = writeStore(store);
  return res.json({
    ok: true,
    added,
    skipped,
    parsed: proxies.length,
    storeUpdatedAt: written.updatedAt,
  });
});

app.post('/v1/pool', (req, res) => {
  const store = readStore();
  const pool = listPoolItems(store);

  const rawItems = Array.isArray(req.body?.items) ? req.body.items : null;
  const text = typeof req.body?.text === 'string' ? req.body.text : null;

  const toAdd = [];
  if (rawItems) {
    for (const it of rawItems) {
      const proxy = normalizeProxy(it?.proxy ?? it);
      if (!proxy) continue;
      toAdd.push({
        id: newId(),
        label: typeof it?.label === 'string' ? it.label.trim() : '',
        enabled: it?.enabled === false ? false : true,
        proxy,
        addedAt: nowIso(),
        lastUsedAt: null,
      });
    }
  } else if (text) {
    for (const line of parseProxyLines(text)) {
      const proxy = normalizeProxy(line);
      if (!proxy) continue;
      toAdd.push({
        id: newId(),
        label: '',
        enabled: true,
        proxy,
        addedAt: nowIso(),
        lastUsedAt: null,
      });
    }
  } else {
    const proxy = normalizeProxy(req.body?.proxy ?? req.body);
    if (!proxy) return res.status(400).json({ ok: false, error: 'invalid payload' });
    toAdd.push({
      id: newId(),
      label: typeof req.body?.label === 'string' ? req.body.label.trim() : '',
      enabled: req.body?.enabled === false ? false : true,
      proxy,
      addedAt: nowIso(),
      lastUsedAt: null,
    });
  }

  const key = (p) => poolItemProxyKey(p);
  const existing = new Set(pool.map((x) => key(x?.proxy)).filter(Boolean));
  const added = [];
  const skipped = [];
  for (const it of toAdd) {
    const k = key(it.proxy);
    if (existing.has(k)) {
      skipped.push(it);
      continue;
    }
    existing.add(k);
    pool.push(it);
    added.push(it);
  }

  store.pool = pool;
  const written = writeStore(store);
  res.json({ ok: true, added: added.length, skipped: skipped.length, storeUpdatedAt: written.updatedAt, items: added });
});

app.put('/v1/pool/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const pool = listPoolItems(store);
  const idx = pool.findIndex((x) => x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

  const cur = pool[idx];
  if (typeof req.body?.enabled === 'boolean') cur.enabled = req.body.enabled;
  if (typeof req.body?.label === 'string') cur.label = req.body.label.trim();
  if (req.body?.proxy != null) {
    const p = normalizeProxy(req.body.proxy);
    if (!p) return res.status(400).json({ ok: false, error: 'invalid proxy' });
    cur.proxy = p;
    cur.kind = 'proxy';
    delete cur.node;
    delete cur.nodeId;
  }
  if (req.body?.node != null) {
    const link = poolItemNodeLink(req.body.node);
    if (!link) return res.status(400).json({ ok: false, error: 'invalid node' });
    cur.node = typeof req.body.node === 'object' ? { ...req.body.node, fullLink: link } : { fullLink: link };
    cur.kind = 'node';
    delete cur.proxy;
  }

  pool[idx] = cur;
  store.pool = pool;
  const written = writeStore(store);
  res.json({ ok: true, item: cur, storeUpdatedAt: written.updatedAt });
});

app.delete('/v1/pool/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const poolRaw = Array.isArray(store.pool) ? store.pool : [];
  const removed = poolRaw.filter((x) => x && typeof x === 'object' && String(x.id || '') === id);
  store.pool = poolRaw.filter((x) => !(x && typeof x === 'object' && String(x.id || '') === id));

  const pruned = pruneProfilePoliciesReferencingPoolIds(store, removed.length ? [id] : []);
  const written = writeStore(store);
  res.json({
    ok: true,
    deleted: removed.length,
    cascade: {
      reason: 'pool_item_deleted',
      prunedProfiles: pruned.affectedProfiles,
      removedPolicyRefs: pruned.removedRefs,
      deletedPolicies: pruned.deletedPolicies,
    },
    storeUpdatedAt: written.updatedAt,
  });
});

app.post('/v1/pool/:id/check', async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const store = readStore();
  const pool = listPoolItems(store);
  const idx = pool.findIndex((x) => x && x.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'not found' });

  const cur = pool[idx];
  const kind = poolItemKind(cur);

  if (kind === 'node') {
    const link = poolItemNodeLink(cur?.node);
    if (!link) return res.status(400).json({ ok: false, error: 'invalid node (missing fullLink)' });

    const nodeObj = cur && typeof cur.node === 'object' ? cur.node : null;
    const protocol =
      typeof nodeObj?.protocol === 'string' && nodeObj.protocol.trim()
        ? nodeObj.protocol.trim()
        : link.startsWith('hysteria2://')
          ? 'hysteria2'
          : link.startsWith('vless://')
            ? 'vless'
            : '';

    let host = typeof nodeObj?.host === 'string' ? nodeObj.host.trim() : '';
    let portNum = nodeObj?.port != null ? Number(nodeObj.port) : NaN;
    if (!host || !Number.isFinite(portNum) || portNum <= 0) {
      try {
        const fake = link.startsWith('vless://')
          ? link.replace(/^vless:\/\//i, 'https://')
          : link.replace(/^hysteria2:\/\//i, 'https://');
        const u = new URL(fake);
        host = host || String(u.hostname || '').trim();
        portNum = Number.isFinite(portNum) && portNum > 0 ? portNum : u.port ? Number(u.port) : 443;
      } catch {
        // ignore
      }
    }
    if (!host) return res.status(400).json({ ok: false, error: 'invalid node host' });
    if (!Number.isFinite(portNum) || portNum <= 0) portNum = 443;

    const defaults = getNodeCheckDefaults();
    const timeoutRaw = req.body?.timeoutMs;
    const timeoutMsParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;
    const timeoutMs = Number.isFinite(timeoutMsParsed)
      ? Math.min(60000, Math.max(500, Math.floor(timeoutMsParsed)))
      : defaults.timeoutMs;

    const checkType = protocol === 'hysteria2' ? 'dns' : 'tcp';
    const startedAt = Date.now();
    const checkedAt = nowIso();
    let ip = null;
    let success = false;
    let error = null;
    let detail = null;

    try {
      ip = await dnsLookup(host, timeoutMs);
      if (checkType === 'dns') {
        success = true;
        detail = `DNS ${ip}`;
      } else {
        await tcpConnect(ip || host, portNum, timeoutMs);
        success = true;
        detail = `TCP ${ip || host}:${portNum}`;
      }
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      error = msg.slice(0, 280);
      detail = checkType === 'dns' ? `DNS failed` : `TCP failed`;
    }

    const ms = Date.now() - startedAt;
    cur.lastCheckAt = checkedAt;
    cur.lastCheckKind = 'node';
    cur.lastCheckType = checkType;
    cur.lastCheckTimeoutMs = timeoutMs;
    cur.lastCheckMs = ms;
    cur.lastCheckOk = !!success;
    cur.lastCheckIp = ip;
    cur.lastCheckDetail = detail;
    cur.lastCheckError = error || '';

    // Clear proxy-check fields (avoid confusion in UI)
    cur.lastCheckUrl = null;
    cur.lastCheckMethod = null;
    cur.lastCheckHttpStatus = null;

    pool[idx] = cur;
    store.pool = pool;
    const written = writeStore(store);
    return res.json({
      ok: true,
      id,
      kind: 'node',
      protocol: protocol || null,
      host,
      port: portNum,
      checkType,
      timeoutMs,
      ip,
      ms,
      success,
      detail,
      error: error || null,
      storeUpdatedAt: written.updatedAt,
      item: cur,
    });
  }

  const proxy = cur && cur.proxy ? cur.proxy : null;
  if (!proxy || !proxy.server) return res.status(400).json({ ok: false, error: 'invalid proxy' });

  let request;
  try {
    ({ request } = require('playwright-core'));
  } catch {
    return res.status(500).json({ ok: false, error: 'missing dependency: playwright-core' });
  }

  const defaults = getPoolCheckDefaults();
  const urlRaw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const methodRaw = typeof req.body?.method === 'string' ? req.body.method.trim() : '';
  const method = (methodRaw || defaults.method).toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) return res.status(400).json({ ok: false, error: 'only GET/HEAD is allowed' });

  let url;
  try {
    url = sanitizeHttpUrl(urlRaw || defaults.url);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'invalid url' });
  }

  const timeoutMs = defaults.timeoutMs;
  const startedAt = Date.now();
  const checkedAt = nowIso();
  let httpStatus = null;
  let ms = null;
  let success = false;
  let error = null;

  const proxyCfg = { server: String(proxy.server).trim() };
  if (typeof proxy.bypass === 'string' && proxy.bypass.trim()) proxyCfg.bypass = proxy.bypass.trim();
  // NOTE: password may be an empty string (valid for some vendors), keep it as-is when present.
  if (typeof proxy.username === 'string') proxyCfg.username = proxy.username;
  if (typeof proxy.password === 'string') proxyCfg.password = proxy.password;

  let ctx = null;
  try {
    ctx = await request.newContext({
      proxy: proxyCfg,
      ignoreHTTPSErrors: true,
    });

    const resp = await ctx.fetch(url, { method, timeout: timeoutMs });
    httpStatus = resp.status();
    success = httpStatus >= 200 && httpStatus < 400;
  } catch (e) {
    const msg = e && e.message ? String(e.message) : String(e);
    error = msg.slice(0, 280);
  } finally {
    ms = Date.now() - startedAt;
    if (ctx) {
      try {
        await ctx.dispose();
      } catch {
        // ignore
      }
    }
  }

  cur.lastCheckAt = checkedAt;
  cur.lastCheckKind = 'proxy';
  cur.lastCheckMs = ms;
  cur.lastCheckUrl = url;
  cur.lastCheckMethod = method;
  cur.lastCheckHttpStatus = httpStatus;
  cur.lastCheckOk = !!success;
  cur.lastCheckError = error || (success ? '' : `HTTP ${httpStatus}`);

  pool[idx] = cur;
  store.pool = pool;
  const written = writeStore(store);

  return res.json({
    ok: true,
    id,
    url,
    method,
    timeoutMs,
    ms,
    httpStatus,
    success,
    error: error || (success ? null : `HTTP ${httpStatus}`),
    storeUpdatedAt: written.updatedAt,
    item: cur,
  });
});

// --- Activation + account distribution (v1) ---

app.post('/v1/client/activate', (req, res) => {
  const machineId = String(req.body?.machineId || '').trim();
  const code = String(req.body?.activationCode || req.body?.code || '').trim().toUpperCase();
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
  if (!code) return res.status(400).json({ ok: false, error: 'activationCode required' });

  const store = readStore();
  const machines = store.machines && typeof store.machines === 'object' ? store.machines : {};
  if (machines[machineId] && machines[machineId].tokenHash) {
    return res.status(409).json({ ok: false, error: 'machine already activated' });
  }

  const codes = Array.isArray(store.activationCodes) ? store.activationCodes : [];
  const idx = codes.findIndex((c) => c && String(c.code).toUpperCase() === code);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'code not found' });
  if (codes[idx].usedAt) return res.status(409).json({ ok: false, error: 'code already used' });
  if (isExpiredIso(codes[idx].expiresAt)) return res.status(410).json({ ok: false, error: 'code expired' });

  // Mark code as used by this machine
  codes[idx].usedAt = nowIso();
  codes[idx].usedByMachineId = machineId;
  store.activationCodes = codes;

  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = sha256Hex(token);
  machines[machineId] = {
    activatedAt: nowIso(),
    lastSeenAt: nowIso(),
    tokenHash,
    allowedProfiles: [],
  };
  store.machines = machines;

  writeStore(store);
  return res.json({ ok: true, machineId, token });
});

app.get('/v1/client/profiles', authClient, (req, res) => {
  const machineId = req.clientMachine.machineId;
  const allowed = Array.isArray(req.clientMachine.allowedProfiles)
    ? req.clientMachine.allowedProfiles.map((s) => String(s)).filter(Boolean)
    : [];

  const available = listAccountProfiles();
  const byName = new Map(available.map((a) => [a.name, a]));
  const profiles = allowed
    .filter((name) => byName.has(name))
    .map((name) => byName.get(name));

  return res.json({
    ok: true,
    machineId,
    profiles,
    missing: allowed.filter((n) => !byName.has(n)),
    accountsDir: ACCOUNTS_DIR,
  });
});

app.get('/v1/client/profiles/:profile', authClient, (req, res) => {
  const machineId = req.clientMachine.machineId;
  let profile;
  try {
    profile = sanitizeProfileName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const allowed = Array.isArray(req.clientMachine.allowedProfiles) ? req.clientMachine.allowedProfiles : [];
  if (!allowed.includes(profile)) return res.status(403).json({ ok: false, error: 'profile not allowed' });

  try {
    const data = readAccountStorageState(profile);
    return res.json({ ok: true, profile, storageState: data });
  } catch {
    return res.status(404).json({ ok: false, error: 'profile not found' });
  }
});

app.get('/v1/client/proxy/:profile', authClient, async (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const allowed = Array.isArray(req.clientMachine.allowedProfiles) ? req.clientMachine.allowedProfiles : [];
  if (!allowed.includes(profile)) return res.status(403).json({ ok: false, error: 'profile not allowed' });

  const store = readStore();
  const entry = store.profiles?.[profile] || null;
  const staticProxy = normalizeProxy(entry?.proxy ?? entry);
  if (staticProxy) {
    return res.json({
      ok: true,
      profile,
      source: 'static',
      proxy: staticProxy,
      updatedAt: entry?.updatedAt || store.updatedAt || null,
    });
  }

  const policy = getProfilePoolPolicy(entry);
  if (policy) {
    const pool = listPoolItems(store);
    const byId = new Map(pool.map((x) => [x.id, x]));
    const allowedItems = policy.items
      .map((x) => ({ ...x, item: byId.get(x.poolItemId) || null }))
      .filter((x) => x.item && x.item.enabled !== false);

    if (allowedItems.length) {
      const priorities = allowedItems.map((x) => x.priority).filter((n) => Number.isFinite(n));
      const best = priorities.length ? Math.min(...priorities) : 0;
      const bucket = allowedItems.filter((x) => x.priority === best);
      const sticky =
        policy.stickyPoolItemId && bucket.some((x) => x.poolItemId === policy.stickyPoolItemId)
          ? bucket.find((x) => x.poolItemId === policy.stickyPoolItemId)
          : null;
      const picked = sticky || bucket[Math.floor(Math.random() * bucket.length)];
      const pickedItem = picked?.item || null;

      if (pickedItem) {
        pickedItem.lastUsedAt = nowIso();

        const nextEntry = entry && typeof entry === 'object' ? entry : {};
        nextEntry.poolPolicy = {
          ...(nextEntry.poolPolicy && typeof nextEntry.poolPolicy === 'object' ? nextEntry.poolPolicy : {}),
          items: sanitizePoolPolicyItems(policy.items),
          stickyPoolItemId: picked.poolItemId,
          stickyAt: nowIso(),
          updatedAt:
            nextEntry.poolPolicy && typeof nextEntry.poolPolicy === 'object' && typeof nextEntry.poolPolicy.updatedAt === 'string'
              ? nextEntry.poolPolicy.updatedAt
              : nowIso(),
        };
        store.profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
        store.profiles[profile] = nextEntry;
        store.pool = pool;
        writeStore(store);

        const kind = poolItemKind(pickedItem);
        if (kind === 'node') {
          const link = poolItemNodeLink(pickedItem?.node);
          if (!link) {
            return res.json({ ok: true, profile, proxy: null, node: null, source: 'profile_pool', updatedAt: store.updatedAt || null });
          }
          return res.json({
            ok: true,
            profile,
            source: 'profile_pool',
            proxy: null,
            node: pickedItem.node,
            poolItemId: pickedItem.id,
            updatedAt: store.updatedAt || null,
          });
        }

        return res.json({
          ok: true,
          profile,
          source: 'profile_pool',
          proxy: pickedItem.proxy,
          poolItemId: pickedItem.id,
          updatedAt: store.updatedAt || null,
        });
      }
    }

    // Policy exists but no enabled items (or nothing could be picked):
    // fall back to global pool to avoid going direct (still mark policyNoAvailable=true).
    const availability = policyAvailability(policy, byId);
    const fallback = pickRandomEnabled(pool);
    if (fallback) {
      fallback.lastUsedAt = nowIso();
      store.pool = pool;
      writeStore(store);
      const kind = poolItemKind(fallback);
      if (kind === 'node') {
        const link = poolItemNodeLink(fallback?.node);
        if (!link) {
          return res.json({
            ok: true,
            profile,
            source: 'profile_pool_fallback',
            proxy: null,
            node: null,
            policyNoAvailable: true,
            policyItems: policy.items.length,
            policyEnabled: allowedItems.length,
            policyMissing: availability.missing,
            policyDisabled: availability.disabled,
            policyUnusable: availability.unusable,
            updatedAt: store.updatedAt || null,
          });
        }
        return res.json({
          ok: true,
          profile,
          source: 'profile_pool_fallback',
          proxy: null,
          node: fallback.node,
          poolItemId: fallback.id,
          policyNoAvailable: true,
          policyItems: policy.items.length,
          policyEnabled: allowedItems.length,
          policyMissing: availability.missing,
          policyDisabled: availability.disabled,
          policyUnusable: availability.unusable,
          updatedAt: store.updatedAt || null,
        });
      }
      return res.json({
        ok: true,
        profile,
        source: 'profile_pool_fallback',
        proxy: fallback.proxy,
        poolItemId: fallback.id,
        policyNoAvailable: true,
        policyItems: policy.items.length,
        policyEnabled: allowedItems.length,
        policyMissing: availability.missing,
        policyDisabled: availability.disabled,
        policyUnusable: availability.unusable,
        updatedAt: store.updatedAt || null,
      });
    }

    return res.json({
      ok: true,
      profile,
      source: 'profile_pool',
      proxy: null,
      node: null,
      policyNoAvailable: true,
      policyItems: policy.items.length,
      policyEnabled: allowedItems.length,
      policyMissing: availability.missing,
      policyDisabled: availability.disabled,
      policyUnusable: availability.unusable,
      updatedAt: store.updatedAt || null,
    });
  }

  const pool = listPoolItems(store);
  const picked = pickRandomEnabled(pool);
  if (picked) {
    picked.lastUsedAt = nowIso();
    store.pool = pool;
    writeStore(store);
    const kind = poolItemKind(picked);
    if (kind === 'node') {
      const link = poolItemNodeLink(picked?.node);
      if (!link) return res.json({ ok: true, profile, proxy: null, node: null, source: 'pool', updatedAt: store.updatedAt || null });
      return res.json({
        ok: true,
        profile,
        source: 'pool',
        proxy: null,
        node: picked.node,
        poolItemId: picked.id,
        updatedAt: store.updatedAt || null,
      });
    }
    return res.json({
      ok: true,
      profile,
      source: 'pool',
      proxy: picked.proxy,
      poolItemId: picked.id,
      updatedAt: store.updatedAt || null,
    });
  }

  // Node fallback (vless/hysteria2): return node metadata + full share link.
  // Client is expected to use sing-box/Clash locally to expose an HTTP/SOCKS proxy for Playwright.
  const nodes = listNodeItems(store);
  const pickedNode = pickRandomEnabledNode(nodes);
  if (pickedNode) {
    pickedNode.lastUsedAt = nowIso();
    store.nodes = nodes;
    writeStore(store);
    return res.json({
      ok: true,
      profile,
      source: 'node',
      proxy: null,
      node: pickedNode,
      nodeId: pickedNode.id,
      updatedAt: store.updatedAt || null,
    });
  }

  const upstreamProxy = await fetchUpstreamProxy(profile);
  if (upstreamProxy) {
    return res.json({
      ok: true,
      profile,
      source: 'upstream',
      proxy: upstreamProxy,
      updatedAt: nowIso(),
    });
  }

  return res.json({ ok: true, profile, proxy: null, source: 'none', updatedAt: store.updatedAt || null });
});

// --- Admin APIs ---

// --- Admin: capture profile storageState via interactive browser ---
const CAPTURES = new Map(); // id -> { profile, browser, context, createdAt }

function getCapture(id) {
  const item = CAPTURES.get(String(id || '').trim());
  if (!item) return null;
  return item;
}

async function safeCloseCapture(item) {
  if (!item) return;
  try {
    if (item.context) await item.context.close().catch(() => {});
  } catch {
    // ignore
  }
  try {
    if (item.browser) await item.browser.close().catch(() => {});
  } catch {
    // ignore
  }
}

app.get('/v1/admin/capture', requireAdmin, (_req, res) => {
  const list = Array.from(CAPTURES.entries()).map(([id, it]) => ({
    id,
    profile: it.profile,
    createdAt: it.createdAt || null,
  }));
  res.json({ ok: true, captures: list });
});

app.post('/v1/admin/capture/start', requireAdmin, async (req, res) => {
  let profile;
  try {
    profile = sanitizeProfileName(req.body?.profile || req.body?.name || '');
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  // Avoid multiple captures for same profile
  for (const it of CAPTURES.values()) {
    if (it && it.profile === profile) {
      return res.status(409).json({ ok: false, error: 'capture already running for this profile' });
    }
  }
  if (CAPTURES.size >= 3) return res.status(429).json({ ok: false, error: 'too many capture sessions' });

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    return res.status(500).json({ ok: false, error: 'missing dependency: playwright-core' });
  }

  const id = newId();
  const channel = String(process.env.PW_CHANNEL || 'chrome').trim() || 'chrome';

  let browser;
  let context;
  try {
    browser = await chromium.launch({
      headless: false,
      channel,
      args: ['--start-maximized'],
    });
    context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    try {
      await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 120000 });
    } catch {
      // Allow user to navigate manually if network is slow/blocked.
    }

    CAPTURES.set(id, { id, profile, browser, context, createdAt: nowIso() });
    return res.json({ ok: true, id, profile, channel });
  } catch (err) {
    await safeCloseCapture({ browser, context });
    return res.status(500).json({ ok: false, error: err.message || 'capture start failed' });
  }
});

app.post('/v1/admin/capture/finish/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const item = getCapture(id);
  if (!item) return res.status(404).json({ ok: false, error: 'capture not found' });

  try {
    const storageState = await item.context.storageState();
    const fp = writeAccountStorageState(item.profile, storageState);
    CAPTURES.delete(id);
    await safeCloseCapture(item);
    return res.json({ ok: true, id, profile: item.profile, filePath: fp });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'capture finish failed' });
  }
});

app.post('/v1/admin/capture/cancel/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id || '').trim();
  const item = getCapture(id);
  if (!item) return res.status(404).json({ ok: false, error: 'capture not found' });
  CAPTURES.delete(id);
  await safeCloseCapture(item);
  return res.json({ ok: true, id });
});

app.post('/v1/admin/codes', requireAdmin, (req, res) => {
  const count = Math.max(1, Math.min(200, Number(req.body?.count || 1)));
  let ttlSec =
    req.body?.ttlSec != null
      ? Number(req.body.ttlSec)
      : Number.isFinite(ACTIVATION_CODE_TTL_SEC_DEFAULT)
        ? ACTIVATION_CODE_TTL_SEC_DEFAULT
        : 0;
  if (!Number.isFinite(ttlSec)) ttlSec = 0;
  ttlSec = Math.max(0, Math.min(60 * 60 * 24 * 365 * 5, Math.floor(ttlSec))); // cap 5 years

  const store = readStore();
  const codes = Array.isArray(store.activationCodes) ? store.activationCodes : [];
  const existing = new Set(codes.map((c) => String(c.code).toUpperCase()));

  const created = [];
  while (created.length < count) {
    const code = genActivationCode();
    if (existing.has(code)) continue;
    existing.add(code);
    const createdAt = nowIso();
    const expiresAt = ttlSec > 0 ? addSecondsIso(ttlSec) : null;
    const item = { code, createdAt, expiresAt, ttlSec, usedAt: null, usedByMachineId: null };
    codes.push(item);
    created.push(item);
  }

  store.activationCodes = codes;
  const written = writeStore(store);
  res.json({ ok: true, created, storeUpdatedAt: written.updatedAt });
});

app.get('/v1/admin/codes', requireAdmin, (_req, res) => {
  const store = readStore();
  const codes = Array.isArray(store.activationCodes) ? store.activationCodes : [];
  res.json({ ok: true, codes: codes.slice().reverse().slice(0, 500) });
});

app.get('/v1/admin/machines', requireAdmin, (_req, res) => {
  const store = readStore();
  const machines = store.machines && typeof store.machines === 'object' ? store.machines : {};
  const list = Object.keys(machines)
    .sort()
    .map((machineId) => ({
      machineId,
      activatedAt: machines[machineId]?.activatedAt || null,
      lastSeenAt: machines[machineId]?.lastSeenAt || null,
      resetAt: machines[machineId]?.resetAt || null,
      allowedProfiles: machines[machineId]?.allowedProfiles || [],
    }));
  res.json({ ok: true, machines: list, accounts: listAccountProfiles() });
});

app.put('/v1/admin/machines/:machineId', requireAdmin, (req, res) => {
  const machineId = String(req.params.machineId || '').trim();
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });
  const allowedProfiles = Array.isArray(req.body?.allowedProfiles)
    ? req.body.allowedProfiles.map((s) => String(s).trim()).filter(Boolean)
    : typeof req.body?.allowedProfilesText === 'string'
      ? req.body.allowedProfilesText
          .split(/\r?\n/g)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const store = readStore();
  const machines = store.machines && typeof store.machines === 'object' ? store.machines : {};
  if (!machines[machineId]) return res.status(404).json({ ok: false, error: 'machine not found' });

  machines[machineId].allowedProfiles = allowedProfiles;
  store.machines = machines;
  const written = writeStore(store);
  res.json({ ok: true, machineId, allowedProfiles, storeUpdatedAt: written.updatedAt });
});

app.post('/v1/admin/machines/:machineId/reset', requireAdmin, (req, res) => {
  const machineId = String(req.params.machineId || '').trim();
  if (!machineId) return res.status(400).json({ ok: false, error: 'machineId required' });

  const store = readStore();
  const machines = store.machines && typeof store.machines === 'object' ? store.machines : {};
  if (!machines[machineId]) return res.status(404).json({ ok: false, error: 'machine not found' });

  machines[machineId].tokenHash = null;
  machines[machineId].allowedProfiles = [];
  machines[machineId].resetAt = nowIso();
  store.machines = machines;
  const written = writeStore(store);
  res.json({ ok: true, machineId, resetAt: machines[machineId].resetAt, storeUpdatedAt: written.updatedAt });
});

app.get('/v1/admin/accounts', requireAdmin, (_req, res) => {
  res.json({ ok: true, accountsDir: ACCOUNTS_DIR, profiles: listAccountProfiles() });
});

app.put('/v1/admin/accounts/:profile', requireAdmin, (req, res) => {
  let profile;
  try {
    profile = sanitizeProfileName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const storageState = req.body?.storageState ?? req.body;
  try {
    // validate JSON shape
    if (!storageState || typeof storageState !== 'object') throw new Error('invalid storageState');
    writeAccountStorageState(profile, storageState);
    return res.json({ ok: true, profile });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'invalid payload' });
  }
});

app.delete('/v1/admin/accounts/:profile', requireAdmin, (req, res) => {
  let profile;
  try {
    profile = sanitizeProfileName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }
  try {
    const fp = accountFilePath(profile);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return res.json({ ok: true, profile });
  } catch {
    return res.status(500).json({ ok: false, error: 'delete failed' });
  }
});

app.get('/v1/proxy/:profile', async (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const store = readStore();
  const entry = store.profiles?.[profile] || null;
  const staticProxy = normalizeProxy(entry?.proxy ?? entry);
  if (staticProxy) {
    return res.json({
      ok: true,
      profile,
      source: 'static',
      proxy: staticProxy,
      updatedAt: entry?.updatedAt || store.updatedAt || null,
    });
  }

  const policy = getProfilePoolPolicy(entry);
  if (policy) {
    const pool = listPoolItems(store);
    const byId = new Map(pool.map((x) => [x.id, x]));
    const allowedItems = policy.items
      .map((x) => ({ ...x, item: byId.get(x.poolItemId) || null }))
      .filter((x) => x.item && x.item.enabled !== false);

    if (allowedItems.length) {
      const priorities = allowedItems.map((x) => x.priority).filter((n) => Number.isFinite(n));
      const best = priorities.length ? Math.min(...priorities) : 0;
      const bucket = allowedItems.filter((x) => x.priority === best);
      const sticky =
        policy.stickyPoolItemId && bucket.some((x) => x.poolItemId === policy.stickyPoolItemId)
          ? bucket.find((x) => x.poolItemId === policy.stickyPoolItemId)
          : null;
      const picked = sticky || bucket[Math.floor(Math.random() * bucket.length)];
      const pickedItem = picked?.item || null;

      if (pickedItem) {
        pickedItem.lastUsedAt = nowIso();

        const nextEntry = entry && typeof entry === 'object' ? entry : {};
        nextEntry.poolPolicy = {
          ...(nextEntry.poolPolicy && typeof nextEntry.poolPolicy === 'object' ? nextEntry.poolPolicy : {}),
          items: sanitizePoolPolicyItems(policy.items),
          stickyPoolItemId: picked.poolItemId,
          stickyAt: nowIso(),
          updatedAt:
            nextEntry.poolPolicy && typeof nextEntry.poolPolicy === 'object' && typeof nextEntry.poolPolicy.updatedAt === 'string'
              ? nextEntry.poolPolicy.updatedAt
              : nowIso(),
        };
        store.profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
        store.profiles[profile] = nextEntry;
        store.pool = pool;
        writeStore(store);

        const kind = poolItemKind(pickedItem);
        if (kind === 'node') {
          return res.json({
            ok: true,
            profile,
            source: 'profile_pool',
            proxy: null,
            node: pickedItem.node || null,
            poolItemId: pickedItem.id,
            updatedAt: store.updatedAt || null,
          });
        }
        return res.json({
          ok: true,
          profile,
          source: 'profile_pool',
          proxy: pickedItem.proxy || null,
          poolItemId: pickedItem.id,
          updatedAt: store.updatedAt || null,
        });
      }
    }

    const availability = policyAvailability(policy, byId);
    const fallback = pickRandomEnabled(pool);
    if (fallback) {
      fallback.lastUsedAt = nowIso();
      store.pool = pool;
      writeStore(store);
      const kind = poolItemKind(fallback);
      if (kind === 'node') {
        const link = poolItemNodeLink(fallback?.node);
        if (!link) {
          return res.json({
            ok: true,
            profile,
            source: 'profile_pool_fallback',
            proxy: null,
            node: null,
            policyNoAvailable: true,
            policyItems: policy.items.length,
            policyEnabled: allowedItems.length,
            policyMissing: availability.missing,
            policyDisabled: availability.disabled,
            policyUnusable: availability.unusable,
            updatedAt: store.updatedAt || null,
          });
        }
        return res.json({
          ok: true,
          profile,
          source: 'profile_pool_fallback',
          proxy: null,
          node: fallback.node,
          poolItemId: fallback.id,
          policyNoAvailable: true,
          policyItems: policy.items.length,
          policyEnabled: allowedItems.length,
          policyMissing: availability.missing,
          policyDisabled: availability.disabled,
          policyUnusable: availability.unusable,
          updatedAt: store.updatedAt || null,
        });
      }
      return res.json({
        ok: true,
        profile,
        source: 'profile_pool_fallback',
        proxy: fallback.proxy,
        poolItemId: fallback.id,
        policyNoAvailable: true,
        policyItems: policy.items.length,
        policyEnabled: allowedItems.length,
        policyMissing: availability.missing,
        policyDisabled: availability.disabled,
        policyUnusable: availability.unusable,
        updatedAt: store.updatedAt || null,
      });
    }

    return res.json({
      ok: true,
      profile,
      source: 'profile_pool',
      proxy: null,
      node: null,
      policyNoAvailable: true,
      policyItems: policy.items.length,
      policyEnabled: allowedItems.length,
      policyMissing: availability.missing,
      policyDisabled: availability.disabled,
      policyUnusable: availability.unusable,
      updatedAt: store.updatedAt || null,
    });
  }

  // Pool fallback: random enabled item
  const pool = listPoolItems(store);
  const picked = pickRandomEnabled(pool);
  if (picked) {
    picked.lastUsedAt = nowIso();
    store.pool = pool;
    writeStore(store);
    return res.json({
      ok: true,
      profile,
      source: 'pool',
      proxy: picked.proxy,
      poolItemId: picked.id,
      updatedAt: store.updatedAt || null,
    });
  }

  const upstreamProxy = await fetchUpstreamProxy(profile);
  if (upstreamProxy) {
    return res.json({
      ok: true,
      profile,
      source: 'upstream',
      proxy: upstreamProxy,
      updatedAt: nowIso(),
    });
  }

  return res.json({ ok: true, profile, proxy: null, source: 'none', updatedAt: store.updatedAt || null });
});

app.put('/v1/proxy/:profile', (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const proxy = normalizeProxy(req.body?.proxy ?? req.body);
  if (!proxy) return res.status(400).json({ ok: false, error: 'invalid proxy payload' });

  const store = readStore();
  store.profiles[profile] = { proxy, updatedAt: nowIso() };
  const written = writeStore(store);
  res.json({ ok: true, profile, proxy, storeUpdatedAt: written.updatedAt });
});

app.delete('/v1/proxy/:profile', (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const store = readStore();
  if (store.profiles && store.profiles[profile]) delete store.profiles[profile];
  const written = writeStore(store);
  res.json({ ok: true, profile, storeUpdatedAt: written.updatedAt });
});

app.get('/v1/proxy-policy/:profile', (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const store = readStore();
  const entry = store.profiles?.[profile] || null;
  const staticProxy = normalizeProxy(entry?.proxy ?? entry);

  const pool = listPoolItems(store);
  const byId = new Map(pool.map((x) => [x.id, x]));

  const policyObj = entry && typeof entry === 'object' && entry.poolPolicy && typeof entry.poolPolicy === 'object' ? entry.poolPolicy : {};
  const items = sanitizePoolPolicyItems(policyObj.items).map((x) => {
    const it = byId.get(x.poolItemId) || null;
    const kind = poolItemKind(it);
    const label =
      typeof it?.label === 'string' && it.label.trim()
        ? it.label.trim()
        : kind === 'node'
          ? String(it?.node?.remark || it?.node?.title || 'node')
          : kind === 'proxy'
            ? String(it?.proxy?.server || 'proxy')
            : '';
    return {
      poolItemId: x.poolItemId,
      priority: x.priority,
      kind: kind || null,
      enabled: it ? it.enabled !== false : false,
      label,
      lastCheckAt: it?.lastCheckAt || null,
      lastCheckOk: typeof it?.lastCheckOk === 'boolean' ? it.lastCheckOk : it?.lastCheckOk == null ? null : null,
    };
  });

  return res.json({
    ok: true,
    profile,
    hasStaticProxy: !!staticProxy,
    staticProxy: staticProxy || null,
    policy: {
      items,
      stickyPoolItemId: typeof policyObj.stickyPoolItemId === 'string' ? policyObj.stickyPoolItemId : null,
      stickyAt: typeof policyObj.stickyAt === 'string' ? policyObj.stickyAt : null,
      updatedAt: typeof policyObj.updatedAt === 'string' ? policyObj.updatedAt : null,
    },
    storeUpdatedAt: store.updatedAt || null,
  });
});

app.put('/v1/proxy-policy/:profile', (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const body = req.body;
  const itemsRaw = Array.isArray(body)
    ? body
    : Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body?.poolItemIds)
        ? body.poolItemIds
        : [];
  const items = sanitizePoolPolicyItems(itemsRaw);
  if (!items.length) return res.status(400).json({ ok: false, error: 'items required' });

  const store = readStore();
  store.profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
  const cur = store.profiles[profile];
  const next = cur && typeof cur === 'object' ? cur : {};
  next.poolPolicy = {
    items,
    updatedAt: nowIso(),
    stickyPoolItemId: null,
    stickyAt: null,
  };
  store.profiles[profile] = next;
  const written = writeStore(store);
  res.json({ ok: true, profile, policy: next.poolPolicy, storeUpdatedAt: written.updatedAt });
});

app.delete('/v1/proxy-policy/:profile', (req, res) => {
  let profile;
  try {
    profile = sanitizeName(req.params.profile);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message || 'bad profile' });
  }

  const store = readStore();
  store.profiles = store.profiles && typeof store.profiles === 'object' ? store.profiles : {};
  const cur = store.profiles[profile];
  if (!cur || typeof cur !== 'object') {
    const written = writeStore(store);
    return res.json({ ok: true, profile, storeUpdatedAt: written.updatedAt });
  }
  delete cur.poolPolicy;
  // If profile entry no longer has anything meaningful, remove it entirely.
  const hasStaticProxy = !!normalizeProxy(cur?.proxy ?? cur);
  const remainingKeys = Object.keys(cur || {}).filter((k) => !['updatedAt'].includes(k));
  if (!hasStaticProxy && remainingKeys.length === 0) {
    delete store.profiles[profile];
  } else {
    store.profiles[profile] = cur;
  }
  const written = writeStore(store);
  res.json({ ok: true, profile, storeUpdatedAt: written.updatedAt });
});

function startServer({ port = PORT, host = HOST } = {}) {
  ensureStore();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    server.once('error', reject);
    server.once('listening', () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === 'object' ? addr.port : port;
      // If binding to 0.0.0.0, prefer a loopback URL for local UI / logs.
      const baseHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const baseUrl = `http://${baseHost}:${actualPort}`;
      const lanUrls = [];
      if (host === '0.0.0.0') {
        try {
          const nets = os.networkInterfaces();
          for (const name of Object.keys(nets || {})) {
            for (const net of nets[name] || []) {
              if (!net || net.internal) continue;
              if (net.family !== 'IPv4') continue;
              lanUrls.push(`http://${net.address}:${actualPort}`);
            }
          }
        } catch {
          // ignore
        }
      }
      RUNTIME.host = host;
      RUNTIME.port = port;
      RUNTIME.actualPort = actualPort;
      RUNTIME.baseUrl = baseUrl;
      RUNTIME.lanUrls = lanUrls;
      RUNTIME.startedAt = nowIso();
      console.log('🧩 Proxy Service started');
      console.log(`📍 本机访问：${baseUrl}`);
      if (lanUrls.length) {
        console.log(`🌐 局域网访问：${lanUrls.join(' , ')}`);
      }
      console.log(`🗂️ store: ${STORE_PATH}`);
      console.log('🔐 admin: open /login.html to sign in');
      if (process.env.PROXY_UPSTREAM_URL) {
        console.log(`🌐 upstream: ${process.env.PROXY_UPSTREAM_URL}`);
      } else {
        console.log('ℹ️ upstream: (disabled) set PROXY_UPSTREAM_URL to enable');
      }

      if (isPoolAutoCheckEnabled()) {
        startPoolNodeAutoToggleLoop(server);
        const cfg = getPoolNodeAutoToggleDefaults();
        console.log(`🧪 pool auto-check: enabled (nodes every ${Math.round(cfg.intervalMs / 1000)}s ×${cfg.tries})`);
      } else {
        console.log('🧪 pool auto-check: disabled (set PROXY_POOL_AUTOCHECK=1 to enable)');
      }
      resolve({ app, server, host, port: actualPort, baseUrl, lanUrls });
    });
  });
}

function getBootstrapInfo() {
  return {
    envLoadedFrom: ENV_LOADED_FROM,
    envHint: configEnvHintPath(),
    adminPasswordSource: ADMIN_PASSWORD_SOURCE,
    // Only for Electron main process usage; do NOT expose this in HTTP endpoints.
    adminPassword: ADMIN_PASSWORD_SOURCE === 'generated' ? ADMIN_PASSWORD : null,
    storePath: STORE_PATH,
    accountsDir: ACCOUNTS_DIR,
  };
}

module.exports = {
  app,
  startServer,
  getBootstrapInfo,
  _internals: {
    removePoolItemsByPredicate,
    pruneProfilePoliciesReferencingPoolIds,
  },
};

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Proxy Service failed to start:', err?.message || err);
    process.exit(1);
  });
}
