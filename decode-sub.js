#!/usr/bin/env node

// decode-sub.js
// 用法：node decode-sub.js "你的订阅URL"
//
// 说明：
// - 订阅一般为 Base64（或 Base64URL）编码的一组链接（每行一个）
// - 当前解析：vless:// 与 hysteria2://

// ==================== 智能国家识别（易维护） ====================
const COUNTRY_PATTERNS = [
  { regex: /🇯🇵|日本|东京|Tokyo|\bJP\b/i, name: '日本' },
  { regex: /🇭🇰|香港|Hong\s*Kong|\bHK\b/i, name: '香港' },
  { regex: /🇸🇬|新加坡|Singapore|\bSG\b/i, name: '新加坡' },
  { regex: /🇺🇸|美国|USA|America|\bUS\b/i, name: '美国' },
  { regex: /🇰🇷|韩国|South\s*Korea|Korea|首尔|Seoul|\bKR\b/i, name: '韩国' },
  { regex: /🇦🇺|澳大利亚|Australia|\bAU\b/i, name: '澳大利亚' },
  { regex: /🇮🇳|印度|India|\bIN\b/i, name: '印度' },
  { regex: /🇹🇼|台湾|Taiwan|\bTW\b/i, name: '台湾' },
  { regex: /🇬🇧|英国|Britain|London|\bUK\b/i, name: '英国' },
  { regex: /🇨🇦|加拿大|Canada|\bCA\b/i, name: '加拿大' },
  { regex: /🇫🇷|法国|France|\bFR\b/i, name: '法国' },
  { regex: /🇩🇪|德国|Germany|\bDE\b/i, name: '德国' },
  // 👇 以后新增国家就在这里加一行即可
  // { regex: /🇧🇷|巴西|Brazil|\bBR\b/i, name: '巴西' },
];

function detectCountry(remark) {
  const r = String(remark || '').trim();
  if (!r) return '其他';
  for (const { regex, name } of COUNTRY_PATTERNS) {
    if (regex.test(r)) return name;
  }
  return '其他';
}

// ==================== 订阅获取/解码 ====================
async function fetchText(url, { timeoutMs = 6500 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: { accept: 'text/plain,*/*' },
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      const sample = String(text || '').slice(0, 800);
      throw new Error(`HTTP ${r.status}${sample ? `: ${sample}` : ''}`);
    }
    return String(text || '').trim();
  } finally {
    clearTimeout(t);
  }
}

function tryDecodeBase64ToUtf8(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  // Remove whitespace/newlines that some vendors include.
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return null;

  // Quick heuristic: if it already looks like a list of links, don’t decode.
  if (raw.includes('://')) return null;

  // Normalize base64url -> base64 and fix padding.
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);

  try {
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    // Heuristic: decoded subscription should contain protocol links.
    if (!decoded || !decoded.includes('://')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function subscriptionTextToLinks(text) {
  const decoded = tryDecodeBase64ToUtf8(text);
  const body = decoded != null ? decoded : String(text || '');
  return body
    .split(/\r?\n/g)
    .map((l) => String(l || '').trim())
    .filter((l) => l && !l.startsWith('#'));
}

// ==================== 节点解析 ====================
function safeDecodeHash(hash) {
  const h = String(hash || '');
  if (!h || !h.startsWith('#')) return '';
  const v = h.slice(1);
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function safeParam(params, key) {
  try {
    const v = params.get(key);
    return v == null ? '' : String(v).trim();
  } catch {
    return '';
  }
}

function parseNodeMeta(u, protocol, remark) {
  const p = u && u.searchParams ? u.searchParams : null;
  const typeParam = p ? safeParam(p, 'type').toLowerCase() : '';
  const security = p ? safeParam(p, 'security').toLowerCase() : '';
  const sni = p ? (safeParam(p, 'sni') || safeParam(p, 'serverName')) : '';
  const alpn = p ? safeParam(p, 'alpn') : '';
  const path = p ? safeParam(p, 'path') : '';
  const wsHost = p ? safeParam(p, 'host') : '';
  const grpcServiceName = p ? (safeParam(p, 'serviceName') || safeParam(p, 'service')) : '';

  let obfs = '';
  let obfsParam = '';
  if (typeParam === 'ws') {
    obfs = 'websocket';
    obfsParam = wsHost;
  } else if (typeParam === 'grpc') {
    obfs = 'grpc';
    obfsParam = grpcServiceName;
  } else if (typeParam) {
    obfs = typeParam;
  }

  const tls =
    protocol === 'hysteria2'
      ? true
      : security === 'tls' || security === 'reality' || String(safeParam(p, 'tls')).trim() === '1';

  return {
    type: protocol === 'vless' ? 'VLESS' : protocol === 'hysteria2' ? 'HYSTERIA2' : String(protocol || '').toUpperCase(),
    title: remark || '',
    tls,
    peer: sni,
    alpn,
    obfs,
    obfsParam,
    path,
    _security: security,
    _transport: typeParam,
  };
}

function parseNodeLink(link) {
  const raw = String(link || '').trim();
  if (!raw) return null;

  const isVmess = raw.startsWith('vmess://');
  const isVless = raw.startsWith('vless://');
  const isHysteria2 = raw.startsWith('hysteria2://');
  if (!isVmess && !isVless && !isHysteria2) return null;

  if (isVmess) {
    const b64 = raw.slice('vmess://'.length).trim();
    if (!b64) return null;

    // Normalize base64url -> base64 and fix padding.
    const normalized = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const pad = normalized.length % 4;
    const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
    let obj;
    try {
      const decoded = Buffer.from(padded, 'base64').toString('utf8');
      obj = JSON.parse(decoded);
    } catch {
      return null;
    }

    const remark = String(obj?.ps || obj?.remark || '').trim() || '未知节点';
    const host = String(obj?.add || obj?.server || '').trim();
    const port = obj?.port != null ? String(obj.port).trim() : '';
    const uuid = String(obj?.id || obj?.uuid || '').trim();
    if (!host) return null;
    if (!uuid) return null;

    const tls = String(obj?.tls || '').trim().toLowerCase();
    const network = String(obj?.net || '').trim().toLowerCase();
    const wsHost = String(obj?.host || '').trim();
    const path = String(obj?.path || '').trim();
    const sni = String(obj?.sni || obj?.servername || '').trim();
    const alpn = String(obj?.alpn || '').trim();

    let obfs = '';
    let obfsParam = '';
    if (network === 'ws') {
      obfs = 'websocket';
      obfsParam = wsHost;
    } else if (network === 'grpc') {
      obfs = 'grpc';
      obfsParam = path;
    } else if (network) {
      obfs = network;
    }

    return {
      protocol: 'vmess',
      host,
      port: port || '443',
      uuid,
      password: '',
      remark,
      country: detectCountry(remark),
      type: 'VMESS',
      title: remark,
      tls: tls === 'tls' || tls === '1' || tls === 'true',
      peer: sni,
      alpn,
      obfs,
      obfsParam,
      path,
      fullLink: raw,
    };
  }

  let u;
  try {
    // NOTE: Node's WHATWG URL does not apply IDN punycode conversion for non-special schemes.
    // Parse with a fake https:// scheme so `hostname` is normalized (important for domains containing 中文).
    const fake = isVless
      ? raw.replace(/^vless:\/\//i, 'https://')
      : raw.replace(/^hysteria2:\/\//i, 'https://');
    u = new URL(fake);
  } catch {
    return null;
  }

  const uuid = u.username || u.password || '';
  const host = u.hostname;
  const port = u.port || '443';
  const remark = safeDecodeHash(u.hash) || '未知节点';
  const protocol = isVless ? 'vless' : 'hysteria2';
  const meta = parseNodeMeta(u, protocol, remark);

  return {
    protocol,
    host,
    port,
    uuid,
    // For hysteria2, the userinfo is password. Keep it in a separate field for clarity.
    password: isHysteria2 ? uuid : '',
    remark,
    country: detectCountry(remark),
    ...meta,
    fullLink: raw,
  };
}

function parseSubscriptionToNodes(text) {
  const links = subscriptionTextToLinks(text);
  const nodes = [];
  for (const link of links) {
    const node = parseNodeLink(link);
    if (node) nodes.push(node);
  }
  return nodes;
}

function groupByCountry(nodes) {
  const groups = {};
  for (const n of nodes) {
    if (!groups[n.country]) groups[n.country] = [];
    groups[n.country].push(n);
  }
  return groups;
}

// ==================== CLI ====================
async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error('❌ 请提供订阅 URL！');
    console.error('用法: node decode-sub.js "https://你的订阅链接"');
    process.exit(1);
  }

  console.log('🔄 正在获取订阅...');
  let text;
  try {
    text = await fetchText(url);
  } catch (err) {
    console.error('❌ 获取失败:', err && err.message ? err.message : String(err));
    process.exit(1);
  }

  console.log('🔓 获取完成，正在解析...');
  const nodes = parseSubscriptionToNodes(text);
  const groups = groupByCountry(nodes);

  console.log(`\n✅ 解析完成！共 ${nodes.length} 个可识别节点\n`);

  Object.keys(groups)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .forEach((country) => {
      console.log(`\n🌍 ${country}节点：`);
      groups[country].forEach((node) => {
        console.log(`${node.host}:${node.port}:${node.uuid}:`);
        // 如需显示备注，取消注释：
        // console.log(`  # ${node.remark}`);
      });
    });

  if (!nodes.length) {
    const sample = String(text || '').slice(0, 400);
    console.log('\n⚠️ 未解析到 vless/hysteria2/vmess 节点。');
    if (sample) console.log(`返回样例（前 400 字符）：\n${sample}`);
  }
}

module.exports = {
  COUNTRY_PATTERNS,
  detectCountry,
  subscriptionTextToLinks,
  parseNodeLink,
  parseSubscriptionToNodes,
  groupByCountry,
};

if (require.main === module) {
  main().catch((err) => {
    console.error('程序异常:', err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
