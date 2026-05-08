const mysql = require('mysql2/promise');

let pool = null;
let disabledLogged = false;

function hasMysqlConfig() {
  return Boolean(
    String(process.env.FLOW_MYSQL_URL || '').trim() ||
      (String(process.env.FLOW_MYSQL_HOST || '').trim() &&
        String(process.env.FLOW_MYSQL_USER || '').trim() &&
        String(process.env.FLOW_MYSQL_DATABASE || '').trim()),
  );
}

function buildConfig() {
  const url = String(process.env.FLOW_MYSQL_URL || '').trim();
  if (url) {
    return {
      uri: url,
      waitForConnections: true,
      connectionLimit: Number(process.env.FLOW_MYSQL_POOL_SIZE || 10),
      queueLimit: 0,
      charset: 'utf8mb4',
      namedPlaceholders: false,
    };
  }
  return {
    host: String(process.env.FLOW_MYSQL_HOST || '').trim(),
    port: Number(process.env.FLOW_MYSQL_PORT || 3306),
    user: String(process.env.FLOW_MYSQL_USER || '').trim(),
    password: String(process.env.FLOW_MYSQL_PASSWORD || '').trim(),
    database: String(process.env.FLOW_MYSQL_DATABASE || '').trim(),
    waitForConnections: true,
    connectionLimit: Number(process.env.FLOW_MYSQL_POOL_SIZE || 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    namedPlaceholders: false,
  };
}

function getPool() {
  if (!hasMysqlConfig()) return null;
  if (!pool) {
    pool = mysql.createPool(buildConfig());
  }
  return pool;
}

function isEnabled() {
  return Boolean(getPool());
}

function logDisabledOnce() {
  if (disabledLogged) return;
  disabledLogged = true;
  console.warn('⚠️ FLOW_MYSQL_* 未配置：共享任务系统与 MySQL 镜像已禁用。');
}

async function query(sql, params = []) {
  const p = getPool();
  if (!p) {
    logDisabledOnce();
    throw new Error('mysql disabled');
  }
  const [rows] = await p.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const p = getPool();
  if (!p) {
    logDisabledOnce();
    throw new Error('mysql disabled');
  }
  const [result] = await p.execute(sql, params);
  return result;
}

async function withConnection(fn) {
  const p = getPool();
  if (!p) {
    logDisabledOnce();
    throw new Error('mysql disabled');
  }
  const conn = await p.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function transaction(fn) {
  return withConnection(async (conn) => {
    await conn.beginTransaction();
    try {
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        // ignore rollback failure
      }
      throw err;
    }
  });
}

module.exports = {
  execute,
  getPool,
  hasMysqlConfig,
  isEnabled,
  query,
  transaction,
  withConnection,
};
