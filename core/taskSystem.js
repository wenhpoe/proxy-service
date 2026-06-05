const crypto = require('crypto');

const mysql = require('./mysql');

const DEFAULT_WORKER_LIMIT = 7;
const DEFAULT_ACCOUNT_MAX_CONCURRENCY = DEFAULT_WORKER_LIMIT;
const MAX_ACCOUNT_MAX_CONCURRENCY = 32;
const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_EXPIRE_SEC = 60 * 60 * 24;
const DEFAULT_IMAGE_TIMEOUT = 15 * 60;
const DEFAULT_VIDEO_TIMEOUT = 40 * 60;
const DEFAULT_STORAGE_ROOT_KEY = 'machine_task_root';

let schemaReady = false;
let bootstrapDone = false;

function nowIso() {
  return new Date().toISOString();
}

function toMysqlDateTime3(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${millis}`;
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value) {
  return JSON.stringify(value == null ? null : value);
}

function normalizeObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function listEnabledProviders(channel) {
  const providers = Array.isArray(channel && channel.providers) ? channel.providers : [];
  return providers.filter((item) => item && item.enabled !== false);
}

function resolveProviderConfig(channel, preferred) {
  const preferredKey = String(preferred || '').trim();
  const enabledProviders = listEnabledProviders(channel);
  if (preferredKey) {
    const matched = enabledProviders.find((item) => String(item.key || '').trim() === preferredKey);
    if (matched) return matched;
  }
  const selectedKey = String(channel && channel.selected_provider || '').trim();
  if (selectedKey) {
    const selected = enabledProviders.find((item) => String(item.key || '').trim() === selectedKey);
    if (selected) return selected;
  }
  return enabledProviders[0] || null;
}

function resolveProviderConstraints(provider) {
  const source = normalizeObject(provider);
  const direct = normalizeObject(source.constraints);
  if (Object.keys(direct).length) return direct;
  return normalizeObject(normalizeObject(source.extra).constraints);
}

function resolveChannelConstraints(channel, providerKey) {
  const channelConstraints = normalizeObject(channel && channel.constraints);
  const providerConstraints = resolveProviderConstraints(resolveProviderConfig(channel, providerKey));
  if (!Object.keys(providerConstraints).length) return { ...channelConstraints };
  return {
    ...channelConstraints,
    ...providerConstraints,
  };
}

function seedanceRemoteIdFromResultPayload(value) {
  const payload = safeJsonParse(value, {});
  const rawResult = payload && typeof payload === 'object' && payload.raw_result && typeof payload.raw_result === 'object'
    ? payload.raw_result
    : {};
  const remoteId = String(rawResult.remote_id || rawResult.id || '').trim();
  return remoteId || null;
}

function isSeedanceCreateUnknownTaskRow(task) {
  if (!task || String(task.channel || '').trim().toLowerCase() !== 'seedance') return false;
  const errorClass = String(task.error_class || '').trim().toLowerCase();
  const errorCode = String(task.error_code || '').trim().toLowerCase();
  if (errorClass !== 'seedance_create_unknown' && errorCode !== 'seedance_create_unknown') return false;
  return !seedanceRemoteIdFromResultPayload(task.result_payload_json);
}

async function requeueTaskById(conn, taskId) {
  await conn.execute(
    `
      UPDATE tasks
      SET status = 'queued',
          next_retry_at = CURRENT_TIMESTAMP(3),
          lease_until = NULL,
          heartbeat_at = NULL,
          claimed_by_slot_id = NULL,
          current_task_run_id = NULL,
          error_class = NULL,
          error_code = NULL,
          error_message = NULL,
          result_payload_json = NULL,
          cancel_requested_at = NULL,
          updated_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?
    `,
    [taskId],
  );
}

function normalizeProfileNames(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeStorageRootKey(value) {
  const raw = String(value || '').trim();
  return raw || DEFAULT_STORAGE_ROOT_KEY;
}

function normalizeAccountMaxConcurrency(value, fallback = DEFAULT_ACCOUNT_MAX_CONCURRENCY) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(MAX_ACCOUNT_MAX_CONCURRENCY, Math.round(fallback)));
  return Math.max(0, Math.min(MAX_ACCOUNT_MAX_CONCURRENCY, Math.round(n)));
}

function taskStatusPriority(status) {
  const value = String(status || '').trim();
  if (value === 'succeeded') return 100;
  if (value === 'failed') return 90;
  if (value === 'cancelled') return 80;
  if (value === 'expired') return 70;
  if (value === 'running') return 60;
  if (value === 'cancel_requested') return 50;
  if (value === 'queued') return 40;
  return 10;
}

function aggregateBatchStatus(taskStatuses) {
  const list = Array.isArray(taskStatuses) ? taskStatuses.filter(Boolean) : [];
  if (!list.length) return 'queued';
  if (list.some((status) => status === 'running' || status === 'cancel_requested')) return 'running';
  if (list.every((status) => status === 'succeeded')) return 'succeeded';
  if (list.every((status) => status === 'cancelled')) return 'cancelled';
  if (list.every((status) => status === 'expired')) return 'expired';
  if (list.some((status) => status === 'failed')) return 'partial_failed';
  if (list.some((status) => status === 'queued')) return 'queued';
  return 'partial_failed';
}

async function ensureSchema() {
  if (schemaReady || !mysql.isEnabled()) return;
  await mysql.withConnection(async (conn) => {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS task_assets (
        id VARCHAR(64) PRIMARY KEY,
        machine_id VARCHAR(191) NOT NULL,
        created_by_machine_id VARCHAR(191) NOT NULL,
        asset_kind VARCHAR(32) NOT NULL,
        storage_root_key VARCHAR(64) NOT NULL,
        relative_path VARCHAR(1024) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(255) NULL,
        size_bytes BIGINT NULL,
        sha256_hex VARCHAR(128) NULL,
        width INT NULL,
        height INT NULL,
        metadata_json LONGTEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_task_assets_machine (machine_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS task_batches (
        id VARCHAR(64) PRIMARY KEY,
        target_machine_id VARCHAR(191) NOT NULL,
        created_by_machine_id VARCHAR(191) NOT NULL,
        created_by_kind VARCHAR(32) NOT NULL DEFAULT 'client',
        idempotency_key VARCHAR(191) NOT NULL,
        priority INT NOT NULL DEFAULT ${DEFAULT_PRIORITY},
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        expire_at DATETIME(3) NULL,
        metadata_json LONGTEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uniq_task_batches_creator_key (created_by_machine_id, idempotency_key),
        KEY idx_task_batches_target (target_machine_id, created_at),
        KEY idx_task_batches_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id VARCHAR(64) PRIMARY KEY,
        batch_id VARCHAR(64) NOT NULL,
        target_machine_id VARCHAR(191) NOT NULL,
        created_by_machine_id VARCHAR(191) NOT NULL,
        channel VARCHAR(64) NOT NULL DEFAULT 'flow',
        provider VARCHAR(64) NOT NULL DEFAULT '1',
        task_type VARCHAR(32) NOT NULL,
        prompt TEXT NOT NULL,
        input_payload_json LONGTEXT NOT NULL,
        required_account_profile VARCHAR(191) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        priority INT NOT NULL DEFAULT ${DEFAULT_PRIORITY},
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT ${DEFAULT_MAX_ATTEMPTS},
        next_retry_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        expire_at DATETIME(3) NULL,
        run_timeout_seconds INT NOT NULL,
        claimed_by_slot_id BIGINT NULL,
        current_task_run_id BIGINT NULL,
        lease_until DATETIME(3) NULL,
        heartbeat_at DATETIME(3) NULL,
        error_class VARCHAR(64) NULL,
        error_code VARCHAR(128) NULL,
        error_message TEXT NULL,
        result_payload_json LONGTEXT NULL,
        cancel_requested_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_tasks_machine_status (target_machine_id, status, next_retry_at, priority, created_at),
        KEY idx_tasks_batch (batch_id, created_at),
        KEY idx_tasks_claimed_slot (claimed_by_slot_id, status),
        KEY idx_tasks_required_account (required_account_profile, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    try {
      await conn.query(`ALTER TABLE tasks ADD COLUMN channel VARCHAR(64) NOT NULL DEFAULT 'flow'`);
    } catch {}
    try {
      await conn.query(`ALTER TABLE tasks ADD COLUMN provider VARCHAR(64) NOT NULL DEFAULT '1'`);
    } catch {}
    await conn.query(`
      CREATE TABLE IF NOT EXISTS task_runs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        task_id VARCHAR(64) NOT NULL,
        batch_id VARCHAR(64) NOT NULL,
        machine_id VARCHAR(191) NOT NULL,
        slot_id BIGINT NULL,
        account_profile VARCHAR(191) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'running',
        heartbeat_at DATETIME(3) NULL,
        lease_until DATETIME(3) NULL,
        started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        finished_at DATETIME(3) NULL,
        error_class VARCHAR(64) NULL,
        error_code VARCHAR(128) NULL,
        error_message TEXT NULL,
        output_summary_json LONGTEXT NULL,
        KEY idx_task_runs_task (task_id, started_at),
        KEY idx_task_runs_slot (slot_id, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        task_id VARCHAR(64) NOT NULL,
        asset_id VARCHAR(64) NOT NULL,
        artifact_role VARCHAR(32) NOT NULL DEFAULT 'output',
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_task_artifacts_task (task_id, sort_order),
        KEY idx_task_artifacts_asset (asset_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS account_slots (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        machine_id VARCHAR(191) NOT NULL,
        account_profile VARCHAR(191) NOT NULL,
        slot_index TINYINT NOT NULL,
        worker_name VARCHAR(191) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'bootstrap_needed',
        is_active TINYINT(1) NOT NULL DEFAULT 0,
        auth_state_version_applied INT NULL,
        current_task_id VARCHAR(64) NULL,
        current_task_run_id BIGINT NULL,
        cooldown_until DATETIME(3) NULL,
        last_heartbeat_at DATETIME(3) NULL,
        last_error_code VARCHAR(128) NULL,
        last_error_at DATETIME(3) NULL,
        runtime_state_updated_at DATETIME(3) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uniq_account_slots_machine_profile_slot (machine_id, account_profile, slot_index),
        KEY idx_account_slots_active (machine_id, is_active, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS slot_runtime_states (
        slot_id BIGINT PRIMARY KEY,
        base_account_auth_version INT NULL,
        storage_state_json LONGTEXT NOT NULL,
        source VARCHAR(64) NOT NULL DEFAULT 'runtime',
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS account_runtime_states (
        machine_id VARCHAR(191) NOT NULL,
        account_profile VARCHAR(191) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'ready',
        cooldown_until DATETIME(3) NULL,
        auth_state_version_applied INT NULL,
        last_error_class VARCHAR(64) NULL,
        last_error_code VARCHAR(128) NULL,
        last_error_at DATETIME(3) NULL,
        risk_window_started_at DATETIME(3) NULL,
        risk_error_count INT NOT NULL DEFAULT 0,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (machine_id, account_profile),
        KEY idx_account_runtime_states_status (machine_id, status, cooldown_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        actor_kind VARCHAR(32) NOT NULL,
        actor_id VARCHAR(191) NULL,
        action VARCHAR(128) NOT NULL,
        target_kind VARCHAR(64) NOT NULL,
        target_id VARCHAR(191) NOT NULL,
        before_json LONGTEXT NULL,
        after_json LONGTEXT NULL,
        reason TEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_audit_logs_target (target_kind, target_id, created_at),
        KEY idx_audit_logs_actor (actor_kind, actor_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_profiles (
        profile_name VARCHAR(191) PRIMARY KEY,
        config_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_pool_items (
        item_id VARCHAR(191) PRIMARY KEY,
        item_kind VARCHAR(32) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        label VARCHAR(255) NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_nodes (
        node_id VARCHAR(191) PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        label VARCHAR(255) NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_machines (
        machine_id VARCHAR(191) PRIMARY KEY,
        token_hash VARCHAR(255) NULL,
        activated_at DATETIME(3) NULL,
        last_seen_at DATETIME(3) NULL,
        reset_at DATETIME(3) NULL,
        worker_limit INT NOT NULL DEFAULT ${DEFAULT_WORKER_LIMIT},
        allowed_profiles_json LONGTEXT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_executor_nodes (
        machine_id VARCHAR(191) PRIMARY KEY,
        status VARCHAR(32) NOT NULL DEFAULT 'stopped',
        started_at DATETIME(3) NULL,
        heartbeat_at DATETIME(3) NULL,
        stopped_at DATETIME(3) NULL,
        version VARCHAR(64) NULL,
        host VARCHAR(255) NULL,
        pid BIGINT NULL,
        worker_limit INT NULL,
        metadata_json LONGTEXT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_cp_executor_nodes_status (status, heartbeat_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [machineNoteCols] = await conn.query(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'cp_machines'
        AND COLUMN_NAME = 'note'
      LIMIT 1
    `);
    if (!Array.isArray(machineNoteCols) || !machineNoteCols.length) {
      await conn.query(`ALTER TABLE cp_machines ADD COLUMN note TEXT NULL AFTER allowed_profiles_json`);
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_activation_codes (
        code VARCHAR(191) PRIMARY KEY,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_accounts (
        profile_name VARCHAR(191) PRIMARY KEY,
        status VARCHAR(32) NOT NULL DEFAULT 'active',
        max_concurrency INT NOT NULL DEFAULT ${DEFAULT_ACCOUNT_MAX_CONCURRENCY},
        note TEXT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    const [accountConcurrencyCols] = await conn.query(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'cp_accounts'
        AND COLUMN_NAME = 'max_concurrency'
      LIMIT 1
    `);
    if (!Array.isArray(accountConcurrencyCols) || !accountConcurrencyCols.length) {
      await conn.query(
        `ALTER TABLE cp_accounts ADD COLUMN max_concurrency INT NOT NULL DEFAULT ${DEFAULT_ACCOUNT_MAX_CONCURRENCY} AFTER status`,
      );
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS cp_account_auth_states (
        profile_name VARCHAR(191) PRIMARY KEY,
        storage_state_json LONGTEXT NOT NULL,
        version INT NOT NULL DEFAULT 1,
        source VARCHAR(64) NOT NULL DEFAULT 'capture',
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  });
  schemaReady = true;
}

async function writeAuditLog({
  actorKind,
  actorId,
  action,
  targetKind,
  targetId,
  before,
  after,
  reason,
}) {
  await ensureSchema();
  await mysql.execute(
    `
      INSERT INTO audit_logs
      (actor_kind, actor_id, action, target_kind, target_id, before_json, after_json, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      String(actorKind || 'system'),
      actorId ? String(actorId) : null,
      String(action || ''),
      String(targetKind || ''),
      String(targetId || ''),
      before == null ? null : safeJsonStringify(before),
      after == null ? null : safeJsonStringify(after),
      reason ? String(reason) : null,
    ],
  );
}

async function listMirroredAccountProfileNamesTx(conn) {
  const [rows] = await conn.execute(
    `
      SELECT profile_name
      FROM cp_accounts
      ORDER BY profile_name ASC
    `,
  );
  return normalizeProfileNames(
    (Array.isArray(rows) ? rows : []).map((row) => row?.profile_name),
  );
}

async function loadProfileConfigRowsTx(conn, profileNames) {
  const names = normalizeProfileNames(profileNames);
  if (!names.length) return new Map();
  const placeholders = names.map(() => '?').join(', ');
  const [rows] = await conn.execute(
    `
      SELECT profile_name, config_json
      FROM cp_profiles
      WHERE profile_name IN (${placeholders})
    `,
    names,
  );
  return new Map(
    (Array.isArray(rows) ? rows : [])
      .filter((row) => row && row.profile_name)
      .map((row) => [String(row.profile_name), safeJsonParse(row.config_json, {})]),
  );
}

async function ensureProfileRowsTx(conn, profileConfigs, { pruneMissing = true } = {}) {
  const entries = profileConfigs && typeof profileConfigs === 'object' ? profileConfigs : {};
  const names = normalizeProfileNames(Object.keys(entries));
  for (const profileName of names) {
    await conn.execute(
      `
        INSERT INTO cp_profiles (profile_name, config_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          config_json = VALUES(config_json),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [profileName, safeJsonStringify(entries[profileName] || {})],
    );
  }
  if (pruneMissing) {
    if (names.length) {
      const placeholders = names.map(() => '?').join(', ');
      await conn.execute(
        `DELETE FROM cp_profiles WHERE profile_name NOT IN (${placeholders})`,
        names,
      );
    } else {
      await conn.execute('DELETE FROM cp_profiles');
    }
  }
  return names.length;
}

async function mirrorStoreSnapshotTx(conn, store, { preserveProfileNames = null } = {}) {
  const snapshot = store && typeof store === 'object' ? store : {};
  const profiles = snapshot.profiles && typeof snapshot.profiles === 'object' ? snapshot.profiles : {};
  const pool = Array.isArray(snapshot.pool) ? snapshot.pool : [];
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const machines = snapshot.machines && typeof snapshot.machines === 'object' ? snapshot.machines : {};
  const activationCodes = Array.isArray(snapshot.activationCodes) ? snapshot.activationCodes : [];

  const storedProfileNames = normalizeProfileNames(Object.keys(profiles));
  const preservedNames = Array.isArray(preserveProfileNames)
    ? normalizeProfileNames(preserveProfileNames)
    : await listMirroredAccountProfileNamesTx(conn);
  const desiredProfileNames = normalizeProfileNames([
    ...storedProfileNames,
    ...preservedNames,
  ]);
  if (desiredProfileNames.length) {
    const existingConfigs = await loadProfileConfigRowsTx(conn, desiredProfileNames);
    const nextProfileConfigs = {};
    for (const profileName of desiredProfileNames) {
      if (Object.prototype.hasOwnProperty.call(profiles, profileName)) {
        nextProfileConfigs[profileName] = profiles[profileName] || {};
        continue;
      }
      nextProfileConfigs[profileName] = existingConfigs.get(profileName) || {};
    }
    await ensureProfileRowsTx(conn, nextProfileConfigs);
  } else {
    await ensureProfileRowsTx(conn, {});
  }

  const poolIds = [];
  for (const item of pool) {
    if (!item || typeof item !== 'object') continue;
    const itemId = String(item.id || '').trim();
    if (!itemId) continue;
    poolIds.push(itemId);
    const itemKind = item.node ? 'node' : 'proxy';
    const enabled = item.enabled === false ? 0 : 1;
    await conn.execute(
      `
        INSERT INTO cp_pool_items (item_id, item_kind, enabled, label, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          item_kind = VALUES(item_kind),
          enabled = VALUES(enabled),
          label = VALUES(label),
          payload_json = VALUES(payload_json),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [itemId, itemKind, enabled, item.label ? String(item.label) : null, safeJsonStringify(item)],
    );
  }
  if (poolIds.length) {
    const placeholders = poolIds.map(() => '?').join(', ');
    await conn.execute(`DELETE FROM cp_pool_items WHERE item_id NOT IN (${placeholders})`, poolIds);
  } else {
    await conn.execute('DELETE FROM cp_pool_items');
  }

  const nodeIds = [];
  for (const item of nodes) {
    if (!item || typeof item !== 'object') continue;
    const nodeId = String(item.id || '').trim();
    if (!nodeId) continue;
    nodeIds.push(nodeId);
    const enabled = item.enabled === false ? 0 : 1;
    await conn.execute(
      `
        INSERT INTO cp_nodes (node_id, enabled, label, payload_json, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          enabled = VALUES(enabled),
          label = VALUES(label),
          payload_json = VALUES(payload_json),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [nodeId, enabled, item.label ? String(item.label) : null, safeJsonStringify(item)],
    );
  }
  if (nodeIds.length) {
    const placeholders = nodeIds.map(() => '?').join(', ');
    await conn.execute(`DELETE FROM cp_nodes WHERE node_id NOT IN (${placeholders})`, nodeIds);
  } else {
    await conn.execute('DELETE FROM cp_nodes');
  }

  const machineIds = Object.keys(machines);
  if (machineIds.length) {
    for (const machineId of machineIds) {
      const entry = machines[machineId] && typeof machines[machineId] === 'object' ? machines[machineId] : {};
      const workerLimit = Number(entry.workerLimit || DEFAULT_WORKER_LIMIT);
      await conn.execute(
        `
          INSERT INTO cp_machines
          (machine_id, token_hash, activated_at, last_seen_at, reset_at, worker_limit, allowed_profiles_json, note, payload_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE
            token_hash = VALUES(token_hash),
            activated_at = VALUES(activated_at),
            last_seen_at = VALUES(last_seen_at),
            reset_at = VALUES(reset_at),
            worker_limit = VALUES(worker_limit),
            allowed_profiles_json = VALUES(allowed_profiles_json),
            note = VALUES(note),
            payload_json = VALUES(payload_json),
            updated_at = CURRENT_TIMESTAMP(3)
        `,
        [
          machineId,
          entry.tokenHash ? String(entry.tokenHash) : null,
          toMysqlDateTime3(entry.activatedAt),
          toMysqlDateTime3(entry.lastSeenAt),
          toMysqlDateTime3(entry.resetAt),
          Number.isFinite(workerLimit) && workerLimit > 0 ? Math.round(workerLimit) : DEFAULT_WORKER_LIMIT,
          safeJsonStringify(Array.isArray(entry.allowedProfiles) ? entry.allowedProfiles : []),
          entry.note ? String(entry.note) : null,
          safeJsonStringify(entry),
        ],
      );
    }
    const placeholders = machineIds.map(() => '?').join(', ');
    await conn.execute(
      `
        DELETE m FROM cp_machines AS m
        LEFT JOIN cp_executor_nodes AS e ON e.machine_id = m.machine_id
        WHERE m.machine_id NOT IN (${placeholders})
          AND e.machine_id IS NULL
      `,
      machineIds,
    );
  } else {
    await conn.execute(
      `
        DELETE m FROM cp_machines AS m
        LEFT JOIN cp_executor_nodes AS e ON e.machine_id = m.machine_id
        WHERE e.machine_id IS NULL
      `,
    );
  }

  const codeValues = [];
  for (const code of activationCodes) {
    if (!code || typeof code !== 'object') continue;
    const value = String(code.code || '').trim();
    if (!value) continue;
    codeValues.push(value);
    await conn.execute(
      `
        INSERT INTO cp_activation_codes (code, payload_json, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          payload_json = VALUES(payload_json),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [value, safeJsonStringify(code)],
    );
  }
  if (codeValues.length) {
    const placeholders = codeValues.map(() => '?').join(', ');
    await conn.execute(`DELETE FROM cp_activation_codes WHERE code NOT IN (${placeholders})`, codeValues);
  } else {
    await conn.execute('DELETE FROM cp_activation_codes');
  }

  return {
    profiles: desiredProfileNames.length,
    poolItems: poolIds.length,
    nodes: nodeIds.length,
    machines: machineIds.length,
    activationCodes: codeValues.length,
  };
}

async function mirrorStoreSnapshot(store) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const summary = await mysql.transaction(async (conn) => mirrorStoreSnapshotTx(conn, store));
  return { ok: true, summary };
}

async function upsertAccountStorageStateTx(conn, profileName, storageState, { source = 'capture' } = {}) {
  const profile = String(profileName || '').trim();
  if (!profile) throw new Error('profile required');
  const payload = storageState && typeof storageState === 'object' ? storageState : {};
  const payloadJson = safeJsonStringify(payload);
  await conn.execute(
    `
      INSERT INTO cp_accounts (profile_name, status, max_concurrency, created_at, updated_at)
      VALUES (?, 'active', ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        updated_at = CURRENT_TIMESTAMP(3)
    `,
    [profile, DEFAULT_ACCOUNT_MAX_CONCURRENCY],
  );
  const [rows] = await conn.execute(
    `SELECT storage_state_json, version FROM cp_account_auth_states WHERE profile_name = ? LIMIT 1`,
    [profile],
  );
  const currentRow = Array.isArray(rows) && rows[0] ? rows[0] : null;
  const currentVersion = currentRow ? Number(currentRow.version || 0) : 0;
  const currentPayloadJson = currentRow ? String(currentRow.storage_state_json || '') : '';
  const nextVersion = currentVersion > 0
    ? currentPayloadJson === payloadJson
      ? currentVersion
      : currentVersion + 1
    : 1;
  await conn.execute(
    `
      INSERT INTO cp_account_auth_states (profile_name, storage_state_json, version, source, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        storage_state_json = VALUES(storage_state_json),
        version = VALUES(version),
        source = VALUES(source),
        updated_at = CURRENT_TIMESTAMP(3)
    `,
    [profile, payloadJson, nextVersion, String(source || 'capture')],
  );
  const existingConfigs = await loadProfileConfigRowsTx(conn, [profile]);
  await ensureProfileRowsTx(conn, {
    [profile]: existingConfigs.get(profile) || {},
  }, { pruneMissing: false });
  return {
    profileName: profile,
    version: nextVersion,
    changed: currentPayloadJson !== payloadJson,
  };
}

async function mirrorAccountStorageState(profileName, storageState, { source = 'capture' } = {}) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const result = await mysql.transaction(async (conn) =>
    upsertAccountStorageStateTx(conn, profileName, storageState, { source }),
  );
  return { ok: true, ...result };
}

async function deleteMirroredAccount(profileName) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const profile = String(profileName || '').trim();
  if (!profile) return { ok: false, reason: 'profile required' };
  await mysql.transaction(async (conn) => {
    await conn.execute(`DELETE FROM cp_account_auth_states WHERE profile_name = ?`, [profile]);
    await conn.execute(`DELETE FROM cp_accounts WHERE profile_name = ?`, [profile]);
    await conn.execute(`DELETE FROM cp_profiles WHERE profile_name = ?`, [profile]);
  });
  return { ok: true };
}

function mapAccountControlRow(row) {
  if (!row) return null;
  return {
    profileName: String(row.profile_name || ''),
    status: String(row.status || 'active'),
    maxConcurrency: normalizeAccountMaxConcurrency(row.max_concurrency, DEFAULT_ACCOUNT_MAX_CONCURRENCY),
    note: row.note ? String(row.note) : '',
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || null,
  };
}

async function listAccountControls({ profileNames = [] } = {}) {
  if (!mysql.isEnabled()) return [];
  await ensureSchema();
  return mysql.withConnection(async (conn) => {
    let rows;
    if (Array.isArray(profileNames) && profileNames.length) {
      const values = Array.from(new Set(profileNames.map((value) => String(value || '').trim()).filter(Boolean)));
      if (!values.length) return [];
      const placeholders = values.map(() => '?').join(', ');
      const [result] = await conn.execute(
        `
          SELECT profile_name, status, max_concurrency, note, created_at, updated_at
          FROM cp_accounts
          WHERE profile_name IN (${placeholders})
          ORDER BY profile_name ASC
        `,
        values,
      );
      rows = result;
    } else {
      const [result] = await conn.execute(
        `
          SELECT profile_name, status, max_concurrency, note, created_at, updated_at
          FROM cp_accounts
          ORDER BY profile_name ASC
        `,
      );
      rows = result;
    }
    return (Array.isArray(rows) ? rows : []).map(mapAccountControlRow).filter(Boolean);
  });
}

async function upsertAccountControl({ profileName, maxConcurrency, note = null, actorId = 'admin' }) {
  if (!mysql.isEnabled()) throw new Error('mysql disabled');
  await ensureSchema();
  const profile = String(profileName || '').trim();
  if (!profile) throw new Error('profile required');
  const nextMaxConcurrency = normalizeAccountMaxConcurrency(maxConcurrency, DEFAULT_ACCOUNT_MAX_CONCURRENCY);
  const nextNote = note == null ? null : String(note).trim() || null;
  return mysql.transaction(async (conn) => {
    const [beforeRows] = await conn.execute(
      `
        SELECT profile_name, status, max_concurrency, note, created_at, updated_at
        FROM cp_accounts
        WHERE profile_name = ?
        LIMIT 1
      `,
      [profile],
    );
    const before = mapAccountControlRow(Array.isArray(beforeRows) ? beforeRows[0] : null);
    await conn.execute(
      `
        INSERT INTO cp_accounts
        (profile_name, status, max_concurrency, note, created_at, updated_at)
        VALUES (?, 'active', ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          status = 'active',
          max_concurrency = VALUES(max_concurrency),
          note = VALUES(note),
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [profile, nextMaxConcurrency, nextNote],
    );
    const [afterRows] = await conn.execute(
      `
        SELECT profile_name, status, max_concurrency, note, created_at, updated_at
        FROM cp_accounts
        WHERE profile_name = ?
        LIMIT 1
      `,
      [profile],
    );
    const after = mapAccountControlRow(Array.isArray(afterRows) ? afterRows[0] : null);
    await writeAuditLog({
      actorKind: 'admin',
      actorId,
      action: 'update_account_control',
      targetKind: 'account',
      targetId: profile,
      before,
      after,
    });
    return after;
  });
}

async function bootstrapLegacyMirror({ store, accounts }) {
  if (bootstrapDone || !mysql.isEnabled()) return;
  await ensureSchema();
  if (store && typeof store === 'object') {
    await mirrorStoreSnapshot(store);
  }
  if (accounts && typeof accounts === 'object') {
    const names = Object.keys(accounts);
    for (const name of names) {
      const state = accounts[name];
      if (state && typeof state === 'object') {
        await mirrorAccountStorageState(name, state, { source: 'bootstrap' });
      }
    }
  }
  bootstrapDone = true;
}

async function syncControlPlaneSnapshot({ store, accounts, actorId = 'admin', source = 'manual_sync' } = {}) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const snapshot = store && typeof store === 'object' ? store : {};
  const accountMap = accounts && typeof accounts === 'object' ? accounts : {};
  const names = Array.from(
    new Set(
      Object.keys(accountMap)
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, 'zh-CN'));

  const summary = await mysql.transaction(async (conn) => {
    let changedAuthStates = 0;
    for (const name of names) {
      const state = accountMap[name];
      if (!state || typeof state !== 'object') continue;
      const result = await upsertAccountStorageStateTx(conn, name, state, { source });
      if (result.changed) changedAuthStates += 1;
    }

    if (names.length) {
      const placeholders = names.map(() => '?').join(', ');
      await conn.execute(`DELETE FROM cp_account_auth_states WHERE profile_name NOT IN (${placeholders})`, names);
      await conn.execute(`DELETE FROM cp_accounts WHERE profile_name NOT IN (${placeholders})`, names);
    } else {
      await conn.execute('DELETE FROM cp_account_auth_states');
      await conn.execute('DELETE FROM cp_accounts');
    }

    const storeSummary = await mirrorStoreSnapshotTx(conn, snapshot, {
      preserveProfileNames: names,
    });

    return {
      ...storeSummary,
      accounts: names.length,
      changedAuthStates,
    };
  });

  await writeAuditLog({
    actorKind: 'admin',
    actorId,
    action: 'sync_control_plane_snapshot',
    targetKind: 'system',
    targetId: 'control_plane_mysql',
    after: summary,
  });
  return { ok: true, summary };
}

function normalizeClientAssetInput(input) {
  const payload = input && typeof input === 'object' ? input : {};
  const storageRootKey = normalizeStorageRootKey(payload.storageRootKey);
  const relativePath = String(payload.relativePath || '').trim();
  const fileName = String(payload.fileName || '').trim();
  if (!relativePath) throw new Error('relativePath required');
  if (!fileName) throw new Error('fileName required');
  return {
    assetKind: String(payload.assetKind || 'input').trim() || 'input',
    fileName,
    height: payload.height != null ? Number(payload.height) : null,
    metadata: payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {},
    mimeType: payload.mimeType ? String(payload.mimeType) : null,
    relativePath,
    sha256Hex: payload.sha256Hex ? String(payload.sha256Hex) : null,
    sizeBytes: payload.sizeBytes != null ? Number(payload.sizeBytes) : null,
    storageRootKey,
    width: payload.width != null ? Number(payload.width) : null,
  };
}

async function registerClientAsset({ machineId, body }) {
  await ensureSchema();
  const normalized = normalizeClientAssetInput(body);
  const assetId = makeId('asset');
  await mysql.execute(
    `
      INSERT INTO task_assets
      (id, machine_id, created_by_machine_id, asset_kind, storage_root_key, relative_path, file_name, mime_type, size_bytes, sha256_hex, width, height, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      assetId,
      machineId,
      machineId,
      normalized.assetKind,
      normalized.storageRootKey,
      normalized.relativePath,
      normalized.fileName,
      normalized.mimeType,
      Number.isFinite(normalized.sizeBytes) ? normalized.sizeBytes : null,
      normalized.sha256Hex,
      Number.isFinite(normalized.width) ? Math.round(normalized.width) : null,
      Number.isFinite(normalized.height) ? Math.round(normalized.height) : null,
      safeJsonStringify(normalized.metadata),
    ],
  );
  const asset = {
    id: assetId,
    machineId,
    assetKind: normalized.assetKind,
    storageRootKey: normalized.storageRootKey,
    relativePath: normalized.relativePath,
    fileName: normalized.fileName,
    mimeType: normalized.mimeType,
    sizeBytes: Number.isFinite(normalized.sizeBytes) ? normalized.sizeBytes : null,
    sha256Hex: normalized.sha256Hex,
    width: Number.isFinite(normalized.width) ? Math.round(normalized.width) : null,
    height: Number.isFinite(normalized.height) ? Math.round(normalized.height) : null,
    metadata: normalized.metadata,
  };
  await writeAuditLog({
    actorKind: 'client_machine',
    actorId: machineId,
    action: 'register_asset',
    targetKind: 'task_asset',
    targetId: assetId,
    after: asset,
  });
  return { ok: true, asset };
}

function normalizeTaskCreateInput(task, defaults = {}) {
  const item = task && typeof task === 'object' ? task : {};
  const channel = String(item.channel || 'flow').trim().toLowerCase() || 'flow';
  const provider = String(item.provider || '1').trim() || '1';
  const taskType = String(item.taskType || item.task_type || 'image').trim().toLowerCase();
  if (!['image', 'video'].includes(taskType)) throw new Error(`unsupported taskType: ${taskType}`);
  const prompt = String(item.prompt || '').trim();
  if (!prompt) throw new Error('prompt required');
  const rawInputPayload = item.inputPayload && typeof item.inputPayload === 'object' ? item.inputPayload : {};
  const rawParams = rawInputPayload.params && typeof rawInputPayload.params === 'object'
    ? rawInputPayload.params
    : item.params && typeof item.params === 'object'
      ? item.params
      : {};
  const rawTaskSettings = item.taskSettings && typeof item.taskSettings === 'object'
    ? item.taskSettings
    : rawInputPayload.taskSettings && typeof rawInputPayload.taskSettings === 'object'
      ? rawInputPayload.taskSettings
      : {};
  const rawOutputSettings = item.outputSettings && typeof item.outputSettings === 'object'
    ? item.outputSettings
    : rawInputPayload.outputSettings && typeof rawInputPayload.outputSettings === 'object'
      ? rawInputPayload.outputSettings
      : {};
  const priority = Number.isFinite(Number(item.priority)) ? Math.round(Number(item.priority)) : defaults.priority;
  const maxAttempts = Number.isFinite(Number(item.maxAttempts))
    ? Math.max(1, Math.min(20, Math.round(Number(item.maxAttempts))))
    : defaults.maxAttempts;
  const runTimeoutSeconds = Number.isFinite(Number(item.runTimeoutSeconds))
    ? Math.max(60, Math.round(Number(item.runTimeoutSeconds)))
    : taskType === 'video'
      ? DEFAULT_VIDEO_TIMEOUT
      : DEFAULT_IMAGE_TIMEOUT;
  const inputPayload = {
    ...rawInputPayload,
    channel,
    provider,
    operation: rawInputPayload.operation
      ? String(rawInputPayload.operation)
      : item.operation
        ? String(item.operation)
        : String(rawInputPayload.operation || `${channel}.run`),
    assets: Array.isArray(rawInputPayload.assets)
      ? rawInputPayload.assets
      : Array.isArray(item.assets)
        ? item.assets
        : [],
    submit_meta: rawInputPayload.submit_meta && typeof rawInputPayload.submit_meta === 'object'
      ? rawInputPayload.submit_meta
      : item.submitMeta && typeof item.submitMeta === 'object'
        ? item.submitMeta
        : {},
    params: rawParams,
    referenceAssetId:
      rawInputPayload.referenceAssetId != null
        ? String(rawInputPayload.referenceAssetId)
        : item.referenceAssetId
          ? String(item.referenceAssetId)
          : null,
    referenceAssetIds: Array.isArray(rawInputPayload.referenceAssetIds)
      ? rawInputPayload.referenceAssetIds.map((value) => String(value)).filter(Boolean)
      : Array.isArray(item.referenceAssetIds)
        ? item.referenceAssetIds.map((value) => String(value)).filter(Boolean)
        : [],
    modelName:
      rawInputPayload.modelName != null
        ? String(rawInputPayload.modelName)
        : item.modelName
          ? String(item.modelName)
          : null,
    aspectRatio:
      rawInputPayload.aspectRatio != null
        ? String(rawInputPayload.aspectRatio)
        : item.aspectRatio
          ? String(item.aspectRatio)
          : null,
    humanSpeedPreset:
      rawInputPayload.humanSpeedPreset != null
        ? String(rawInputPayload.humanSpeedPreset)
        : item.humanSpeedPreset
          ? String(item.humanSpeedPreset)
          : null,
    taskSettings: rawTaskSettings,
    outputSettings: rawOutputSettings,
  };
  if (channel === 'seedance') {
    if (taskType !== 'video') {
      throw new Error('seedance requires taskType=video');
    }
    const channelCatalog = defaults.channelCatalog && typeof defaults.channelCatalog === 'object'
      ? defaults.channelCatalog
      : null;
    const channelConfig = Array.isArray(channelCatalog?.channels)
      ? channelCatalog.channels.find((entry) => String(entry?.key || '').trim().toLowerCase() === 'seedance') || null
      : null;
    const constraints = resolveChannelConstraints(channelConfig, provider);
    const requiresReferenceImage = constraints.requires_image === true;
    const hasReferenceAsset = Boolean(inputPayload.referenceAssetId)
      || (Array.isArray(inputPayload.referenceAssetIds) && inputPayload.referenceAssetIds.length > 0);
    if (requiresReferenceImage && !hasReferenceAsset) {
      throw new Error('seedance requires referenceAssetId');
    }
  }
  return {
    channel,
    provider,
    taskType,
    prompt,
    priority: Number.isFinite(priority) ? priority : DEFAULT_PRIORITY,
    maxAttempts,
    runTimeoutSeconds,
    requiredAccountProfile: item.requiredAccountProfile
      ? String(item.requiredAccountProfile)
      : item.required_account_id
        ? String(item.required_account_id)
        : null,
    inputPayload,
  };
}

async function refreshBatchStatus(batchId, conn = null) {
  const run = async (db) => {
    const [rows] = await db.execute(
      `SELECT status FROM tasks WHERE batch_id = ? ORDER BY created_at ASC`,
      [batchId],
    );
    const statuses = Array.isArray(rows) ? rows.map((row) => String(row.status || 'queued')) : [];
    const nextStatus = aggregateBatchStatus(statuses);
    await db.execute(
      `UPDATE task_batches SET status = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [nextStatus, batchId],
    );
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function createClientTaskBatch({ machineId, targetMachineId = '', body, channelCatalog = null }) {
  await ensureSchema();
  const createdByMachineId = String(machineId || '').trim();
  if (!createdByMachineId) throw new Error('machineId required');
  const payload = body && typeof body === 'object' ? body : {};
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  if (!tasks.length) throw new Error('tasks required');
  const idempotencyKey = String(payload.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('idempotencyKey required');
  const priority = Number.isFinite(Number(payload.priority))
    ? Math.round(Number(payload.priority))
    : DEFAULT_PRIORITY;
  const expireAt = payload.expireAt
    ? new Date(payload.expireAt)
    : new Date(Date.now() + DEFAULT_EXPIRE_SEC * 1000);
  if (!Number.isFinite(expireAt.getTime())) throw new Error('invalid expireAt');
  const createdByKind = String(payload.createdByKind || 'client').trim() || 'client';
  const effectiveTargetMachineId = String(targetMachineId || payload.targetMachineId || '').trim() || createdByMachineId;

  return mysql.transaction(async (conn) => {
    const [existingRows] = await conn.execute(
      `
        SELECT id, status, target_machine_id, created_by_machine_id, priority, expire_at, created_at, updated_at
        FROM task_batches
        WHERE created_by_machine_id = ? AND idempotency_key = ?
        LIMIT 1
      `,
      [createdByMachineId, idempotencyKey],
    );
    if (Array.isArray(existingRows) && existingRows[0]) {
      return getClientTaskBatch({ machineId: createdByMachineId, batchId: String(existingRows[0].id), conn });
    }

    const batchId = makeId('batch');
    const batchRow = buildQueuedBatchRow({
      batchId,
      targetMachineId: effectiveTargetMachineId,
      createdByMachineId,
      createdByKind,
      idempotencyKey,
      priority,
      expireAt,
      metadata: payload.metadata,
    });
    await conn.execute(
      `
        INSERT INTO task_batches
        (id, target_machine_id, created_by_machine_id, created_by_kind, idempotency_key, priority, status, expire_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
      [
        batchId,
        effectiveTargetMachineId,
        createdByMachineId,
        createdByKind,
        idempotencyKey,
        priority,
        expireAt,
        safeJsonStringify(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
      ],
    );

    const normalizedTasks = tasks.map((task) =>
      normalizeTaskCreateInput(task, {
        priority,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        channelCatalog,
      }),
    );
    const createdTaskRows = [];
    for (const item of normalizedTasks) {
      const taskId = makeId('task');
      createdTaskRows.push(
        buildQueuedTaskRow({
          taskId,
          batchId,
          targetMachineId: effectiveTargetMachineId,
          createdByMachineId,
          item,
          expireAt,
        }),
      );
      await conn.execute(
        `
          INSERT INTO tasks
          (id, batch_id, target_machine_id, created_by_machine_id, channel, provider, task_type, prompt, input_payload_json, required_account_profile, status, priority, attempt_count, max_attempts, next_retry_at, expire_at, run_timeout_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, CURRENT_TIMESTAMP(3), ?, ?)
        `,
        [
          taskId,
          batchId,
          effectiveTargetMachineId,
          createdByMachineId,
          item.channel,
          item.provider,
          item.taskType,
          item.prompt,
          safeJsonStringify(item.inputPayload),
          item.requiredAccountProfile,
          item.priority,
          item.maxAttempts,
          expireAt,
          item.runTimeoutSeconds,
        ],
      );
    }
    await writeAuditLog({
      actorKind: 'client_machine',
      actorId: createdByMachineId,
      action: 'create_batch',
      targetKind: 'task_batch',
      targetId: batchId,
      after: {
        batchId,
        taskCount: normalizedTasks.length,
        targetMachineId: effectiveTargetMachineId,
        priority,
        expireAt: expireAt.toISOString(),
      },
    });
    return mapBatchRow(batchRow, createdTaskRows.map((row) => mapTaskRow(row)));
  });
}

function mapAssetRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    assetKind: String(row.asset_kind),
    storageRootKey: String(row.storage_root_key),
    relativePath: String(row.relative_path),
    fileName: String(row.file_name),
    mimeType: row.mime_type ? String(row.mime_type) : null,
    sizeBytes: row.size_bytes != null ? Number(row.size_bytes) : null,
    sha256Hex: row.sha256_hex ? String(row.sha256_hex) : null,
    width: row.width != null ? Number(row.width) : null,
    height: row.height != null ? Number(row.height) : null,
    metadata: safeJsonParse(row.metadata_json, {}),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || null,
  };
}

function mapTaskRow(row, { runs = [], artifacts = [] } = {}) {
  if (!row) return null;
  const resultPayload = safeJsonParse(row.result_payload_json, {});
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    targetMachineId: String(row.target_machine_id),
    createdByMachineId: String(row.created_by_machine_id),
    channel: String(row.channel || 'flow'),
    provider: String(row.provider || '1'),
    taskType: String(row.task_type),
    prompt: String(row.prompt),
    inputPayload: safeJsonParse(row.input_payload_json, {}),
    requiredAccountProfile: row.required_account_profile ? String(row.required_account_profile) : null,
    status: String(row.status),
    priority: Number(row.priority || 0),
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 0),
    nextRetryAt: row.next_retry_at instanceof Date ? row.next_retry_at.toISOString() : row.next_retry_at || null,
    expireAt: row.expire_at instanceof Date ? row.expire_at.toISOString() : row.expire_at || null,
    runTimeoutSeconds: Number(row.run_timeout_seconds || 0),
    claimedBySlotId: row.claimed_by_slot_id != null ? Number(row.claimed_by_slot_id) : null,
    currentTaskRunId: row.current_task_run_id != null ? Number(row.current_task_run_id) : null,
    leaseUntil: row.lease_until instanceof Date ? row.lease_until.toISOString() : row.lease_until || null,
    heartbeatAt: row.heartbeat_at instanceof Date ? row.heartbeat_at.toISOString() : row.heartbeat_at || null,
    errorClass: row.error_class ? String(row.error_class) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    resultPayload,
    artifacts,
    runs,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || null,
  };
}

function mapRunRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    taskId: String(row.task_id),
    batchId: String(row.batch_id),
    machineId: String(row.machine_id),
    slotId: row.slot_id != null ? Number(row.slot_id) : null,
    accountProfile: row.account_profile ? String(row.account_profile) : null,
    status: String(row.status),
    heartbeatAt: row.heartbeat_at instanceof Date ? row.heartbeat_at.toISOString() : row.heartbeat_at || null,
    leaseUntil: row.lease_until instanceof Date ? row.lease_until.toISOString() : row.lease_until || null,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at || null,
    finishedAt: row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at || null,
    errorClass: row.error_class ? String(row.error_class) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    outputSummary: safeJsonParse(row.output_summary_json, {}),
  };
}

function mapBatchRow(row, tasks) {
  if (!row) return null;
  const taskList = Array.isArray(tasks) ? tasks : [];
  return {
    id: String(row.id),
    targetMachineId: String(row.target_machine_id),
    createdByMachineId: String(row.created_by_machine_id),
    createdByKind: String(row.created_by_kind || 'client'),
    idempotencyKey: String(row.idempotency_key),
    priority: Number(row.priority || 0),
    status: String(row.status),
    expireAt: row.expire_at instanceof Date ? row.expire_at.toISOString() : row.expire_at || null,
    metadata: safeJsonParse(row.metadata_json, {}),
    taskCount: taskList.length,
    tasks: taskList,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || null,
  };
}

function buildQueuedTaskRow({
  taskId,
  batchId,
  targetMachineId,
  createdByMachineId,
  item,
  expireAt,
}) {
  const now = new Date().toISOString();
  return {
    id: String(taskId),
    batch_id: String(batchId),
    target_machine_id: String(targetMachineId),
    created_by_machine_id: String(createdByMachineId),
    channel: String(item.channel || 'flow'),
    provider: String(item.provider || '1'),
    task_type: String(item.taskType),
    prompt: String(item.prompt),
    input_payload_json: safeJsonStringify(item.inputPayload),
    required_account_profile: item.requiredAccountProfile || null,
    status: 'queued',
    priority: Number(item.priority || DEFAULT_PRIORITY),
    attempt_count: 0,
    max_attempts: Number(item.maxAttempts || DEFAULT_MAX_ATTEMPTS),
    next_retry_at: now,
    expire_at: expireAt instanceof Date ? expireAt.toISOString() : expireAt || null,
    run_timeout_seconds: Number(item.runTimeoutSeconds || 0),
    claimed_by_slot_id: null,
    current_task_run_id: null,
    lease_until: null,
    heartbeat_at: null,
    error_class: null,
    error_code: null,
    error_message: null,
    result_payload_json: safeJsonStringify({}),
    created_at: now,
    updated_at: now,
  };
}

function buildQueuedBatchRow({
  batchId,
  targetMachineId,
  createdByMachineId,
  createdByKind,
  idempotencyKey,
  priority,
  expireAt,
  metadata,
}) {
  const now = new Date().toISOString();
  return {
    id: String(batchId),
    target_machine_id: String(targetMachineId),
    created_by_machine_id: String(createdByMachineId),
    created_by_kind: String(createdByKind || 'client'),
    idempotency_key: String(idempotencyKey),
    priority: Number(priority || DEFAULT_PRIORITY),
    status: 'queued',
    expire_at: expireAt instanceof Date ? expireAt.toISOString() : expireAt || null,
    metadata_json: safeJsonStringify(metadata && typeof metadata === 'object' ? metadata : {}),
    created_at: now,
    updated_at: now,
  };
}

function dateToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function mapExecutorMachineRow(row, { requesterMachineId, offlineAfterSeconds = 45 } = {}) {
  if (!row) return null;
  const machineId = String(row.machine_id || '').trim();
  if (!machineId) return null;
  const heartbeatAt = row.executor_heartbeat_at ? new Date(row.executor_heartbeat_at) : null;
  const heartbeatFresh = Boolean(
    heartbeatAt && Number.isFinite(heartbeatAt.getTime()) && Date.now() - heartbeatAt.getTime() <= offlineAfterSeconds * 1000,
  );
  const rawExecutorStatus = String(row.executor_status || '').trim() || null;
  const executorOnline = Boolean(rawExecutorStatus === 'running' && heartbeatFresh);
  const executorStatus = executorOnline ? 'running' : rawExecutorStatus || 'offline';
  const slotCount = Number(row.slot_count || 0);
  const activeSlots = Number(row.active_slot_count || 0);
  const workerLimit = row.worker_limit != null ? Number(row.worker_limit) : DEFAULT_WORKER_LIMIT;
  const allowedProfiles = safeJsonParse(row.allowed_profiles_json, []);
  return {
    machineId,
    isSelf: machineId === String(requesterMachineId || '').trim(),
    note: row.note ? String(row.note) : null,
    workerLimit,
    allowedProfiles: normalizeProfileNames(Array.isArray(allowedProfiles) ? allowedProfiles : []),
    canExecute: Boolean(executorOnline && workerLimit > 0),
    activatedAt: dateToIso(row.activated_at),
    lastSeenAt: dateToIso(row.last_seen_at),
    executor: {
      registered: Boolean(rawExecutorStatus),
      status: executorStatus,
      rawStatus: rawExecutorStatus,
      online: executorOnline,
      heartbeatFresh,
      heartbeatAt: dateToIso(row.executor_heartbeat_at),
      startedAt: dateToIso(row.executor_started_at),
      stoppedAt: dateToIso(row.executor_stopped_at),
      version: row.executor_version ? String(row.executor_version) : null,
      host: row.executor_host ? String(row.executor_host) : null,
      pid: row.executor_pid != null ? Number(row.executor_pid) : null,
      slotCount,
      activeSlots,
    },
  };
}

async function listExecutorMachines({ requesterMachineId = '', offlineAfterSeconds = 45 } = {}) {
  if (!mysql.isEnabled()) return [];
  await ensureSchema();
  return mysql.withConnection(async (conn) => {
    const safeOfflineAfterSeconds = Math.max(5, Math.min(600, Number(offlineAfterSeconds) || 45));
    const [rows] = await conn.query(
      `
        SELECT
          base.machine_id,
          m.activated_at,
          m.last_seen_at,
          COALESCE(m.worker_limit, e.worker_limit, 0) AS worker_limit,
          m.allowed_profiles_json,
          m.note,
          e.status AS executor_status,
          e.started_at AS executor_started_at,
          e.heartbeat_at AS executor_heartbeat_at,
          e.stopped_at AS executor_stopped_at,
          e.version AS executor_version,
          e.host AS executor_host,
          e.pid AS executor_pid,
          COUNT(s.id) AS slot_count,
          COALESCE(SUM(CASE WHEN s.is_active = 1 THEN 1 ELSE 0 END), 0) AS active_slot_count
        FROM (
          SELECT machine_id FROM cp_machines
          UNION
          SELECT machine_id FROM cp_executor_nodes
        ) AS base
        LEFT JOIN cp_machines AS m ON m.machine_id = base.machine_id
        LEFT JOIN cp_executor_nodes AS e ON e.machine_id = base.machine_id
        LEFT JOIN account_slots AS s ON s.machine_id = base.machine_id
        GROUP BY
          base.machine_id,
          m.activated_at,
          m.last_seen_at,
          m.worker_limit,
          e.worker_limit,
          m.allowed_profiles_json,
          m.note,
          e.status,
          e.started_at,
          e.heartbeat_at,
          e.stopped_at,
          e.version,
          e.host,
          e.pid
        ORDER BY
          CASE WHEN base.machine_id = ? THEN 0 ELSE 1 END,
          CASE WHEN e.status = 'running' AND e.heartbeat_at > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND) THEN 0 ELSE 1 END,
          base.machine_id ASC
      `,
      [String(requesterMachineId || '').trim(), safeOfflineAfterSeconds],
    );
    return (Array.isArray(rows) ? rows : [])
      .map((row) => mapExecutorMachineRow(row, { requesterMachineId, offlineAfterSeconds: safeOfflineAfterSeconds }))
      .filter(Boolean);
  });
}

async function getTaskArtifacts({ taskIds, conn = null }) {
  const ids = Array.isArray(taskIds) ? taskIds.filter(Boolean) : [];
  if (!ids.length) return new Map();
  const run = async (db) => {
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await db.execute(
      `
        SELECT
          ta.id,
          tt.task_id,
          ta.machine_id,
          ta.asset_kind,
          ta.storage_root_key,
          ta.relative_path,
          ta.file_name,
          ta.mime_type,
          ta.size_bytes,
          ta.sha256_hex,
          ta.width,
          ta.height,
          ta.metadata_json,
          ta.created_at,
          ta.updated_at
        FROM task_artifacts tt
        INNER JOIN task_assets ta ON ta.id = tt.asset_id
        WHERE tt.task_id IN (${placeholders})
        ORDER BY tt.sort_order ASC, tt.id ASC
      `,
      ids,
    ).catch(() => [[], null]);
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const taskId = String(row.task_id);
      if (!out.has(taskId)) out.set(taskId, []);
      out.get(taskId).push(mapAssetRow(row));
    }
    return out;
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function getTaskRunsByTaskIds({ taskIds, conn = null }) {
  const ids = Array.isArray(taskIds) ? taskIds.filter(Boolean) : [];
  if (!ids.length) return new Map();
  const run = async (db) => {
    const placeholders = ids.map(() => '?').join(', ');
    const [rows] = await db.execute(
      `
        SELECT *
        FROM task_runs
        WHERE task_id IN (${placeholders})
        ORDER BY started_at ASC, id ASC
      `,
      ids,
    );
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const taskId = String(row.task_id);
      if (!out.has(taskId)) out.set(taskId, []);
      out.get(taskId).push(mapRunRow(row));
    }
    return out;
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function getClientTask({ machineId, taskId, conn = null }) {
  await ensureSchema();
  const run = async (db) => {
    const [rows] = await db.execute(
      `
        SELECT *
        FROM tasks
        WHERE id = ?
          AND (created_by_machine_id = ? OR target_machine_id = ?)
        LIMIT 1
      `,
      [taskId, machineId, machineId],
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;
    const runsMap = await getTaskRunsByTaskIds({ taskIds: [taskId], conn: db });
    const artifactsMap = await getTaskArtifacts({ taskIds: [taskId], conn: db });
    return mapTaskRow(row, {
      runs: runsMap.get(String(taskId)) || [],
      artifacts: artifactsMap.get(String(taskId)) || [],
    });
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function getClientTaskBatch({ machineId, batchId, conn = null }) {
  await ensureSchema();
  const run = async (db) => {
    const [batchRows] = await db.execute(
      `
        SELECT *
        FROM task_batches
        WHERE id = ?
          AND (created_by_machine_id = ? OR target_machine_id = ?)
        LIMIT 1
      `,
      [batchId, machineId, machineId],
    );
    const batchRow = Array.isArray(batchRows) ? batchRows[0] : null;
    if (!batchRow) return null;
    const [taskRows] = await db.execute(
      `
        SELECT *
        FROM tasks
        WHERE batch_id = ?
        ORDER BY created_at ASC, id ASC
      `,
      [batchId],
    );
    const taskIds = Array.isArray(taskRows) ? taskRows.map((row) => String(row.id)) : [];
    const runsMap = await getTaskRunsByTaskIds({ taskIds, conn: db });
    const artifactsMap = await getTaskArtifacts({ taskIds, conn: db });
    const tasks = (Array.isArray(taskRows) ? taskRows : []).map((row) =>
      mapTaskRow(row, {
        runs: runsMap.get(String(row.id)) || [],
        artifacts: artifactsMap.get(String(row.id)) || [],
      }),
    );
    return mapBatchRow(batchRow, tasks);
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function listClientTaskBatches({ machineId, limit = 20, conn = null }) {
  await ensureSchema();
  const requesterMachineId = String(machineId || '').trim();
  if (!requesterMachineId) throw new Error('machineId required');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const run = async (db) => {
    const [rows] = await db.query(
      `
        SELECT id
        FROM task_batches
        WHERE created_by_machine_id = ?
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ${safeLimit}
      `,
      [requesterMachineId],
    );
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const batch = await getClientTaskBatch({
        machineId: requesterMachineId,
        batchId: String(row.id),
        conn: db,
      });
      if (batch) out.push(batch);
    }
    return out;
  };
  if (conn) return run(conn);
  return mysql.withConnection(run);
}

async function listAdminTasks({
  limit = 100,
  status = '',
  machineId = '',
  batchId = '',
  taskType = '',
}) {
  await ensureSchema();
  const clauses = ['1=1'];
  const params = [];
  if (status) {
    clauses.push('t.status = ?');
    params.push(status);
  }
  if (machineId) {
    clauses.push('t.target_machine_id = ?');
    params.push(machineId);
  }
  if (batchId) {
    clauses.push('t.batch_id = ?');
    params.push(batchId);
  }
  if (taskType) {
    clauses.push('t.task_type = ?');
    params.push(taskType);
  }
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)));
  const rows = await mysql.query(
    `
      SELECT t.*
      FROM tasks t
      WHERE ${clauses.join(' AND ')}
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT ?
    `,
    params,
  );
  const taskIds = rows.map((row) => String(row.id));
  const runsMap = await getTaskRunsByTaskIds({ taskIds });
  const artifactsMap = await getTaskArtifacts({ taskIds });
  return rows.map((row) =>
    mapTaskRow(row, {
      runs: runsMap.get(String(row.id)) || [],
      artifacts: artifactsMap.get(String(row.id)) || [],
    }),
  );
}

function normalizeStatsDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 30;
  return Math.max(1, Math.min(365, Math.round(n)));
}

function mapCountRow(row) {
  return {
    key: String(row.key || ''),
    totalTasks: Number(row.total_tasks || 0),
    queuedTasks: Number(row.queued_tasks || 0),
    runningTasks: Number(row.running_tasks || 0),
    succeededTasks: Number(row.succeeded_tasks || 0),
    failedTasks: Number(row.failed_tasks || 0),
    cancelledTasks: Number(row.cancelled_tasks || 0),
    totalRuns: Number(row.total_runs || 0),
    outputCount: Number(row.output_count || 0),
    firstCreatedAt: row.first_created_at instanceof Date ? row.first_created_at.toISOString() : row.first_created_at || null,
    lastUpdatedAt: row.last_updated_at instanceof Date ? row.last_updated_at.toISOString() : row.last_updated_at || null,
  };
}

async function getAdminTaskStats({ days = 30, machineId = '' } = {}) {
  await ensureSchema();
  const safeDays = normalizeStatsDays(days);
  const clauses = [`t.created_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ${safeDays} DAY)`];
  const params = [];
  const normalizedMachineId = String(machineId || '').trim();
  if (normalizedMachineId) {
    clauses.push('(t.target_machine_id = ? OR t.created_by_machine_id = ?)');
    params.push(normalizedMachineId, normalizedMachineId);
  }
  const whereSql = clauses.join(' AND ');
  const baseJoin = `
    FROM tasks t
    LEFT JOIN (
      SELECT task_id, COUNT(*) AS run_count
      FROM task_runs
      GROUP BY task_id
    ) tr ON tr.task_id = t.id
    LEFT JOIN (
      SELECT task_id, COUNT(*) AS artifact_count
      FROM task_artifacts
      GROUP BY task_id
    ) ta ON ta.task_id = t.id
    WHERE ${whereSql}
  `;
  const summaryRows = await mysql.query(
    `
      SELECT
        COUNT(*) AS total_tasks,
        SUM(t.status = 'queued') AS queued_tasks,
        SUM(t.status = 'running') AS running_tasks,
        SUM(t.status = 'succeeded') AS succeeded_tasks,
        SUM(t.status = 'failed') AS failed_tasks,
        SUM(t.status IN ('cancelled', 'cancel_requested', 'expired')) AS cancelled_tasks,
        COALESCE(SUM(tr.run_count), 0) AS total_runs,
        COALESCE(SUM(ta.artifact_count), 0) AS output_count,
        MIN(t.created_at) AS first_created_at,
        MAX(t.updated_at) AS last_updated_at
      ${baseJoin}
    `,
    params,
  );
  const groupedSql = (expr) => `
      SELECT
        ${expr} AS \`key\`,
        COUNT(*) AS total_tasks,
        SUM(t.status = 'queued') AS queued_tasks,
        SUM(t.status = 'running') AS running_tasks,
        SUM(t.status = 'succeeded') AS succeeded_tasks,
        SUM(t.status = 'failed') AS failed_tasks,
        SUM(t.status IN ('cancelled', 'cancel_requested', 'expired')) AS cancelled_tasks,
        COALESCE(SUM(tr.run_count), 0) AS total_runs,
        COALESCE(SUM(ta.artifact_count), 0) AS output_count,
        MIN(t.created_at) AS first_created_at,
        MAX(t.updated_at) AS last_updated_at
      ${baseJoin}
      GROUP BY ${expr}
      ORDER BY total_tasks DESC, output_count DESC, \`key\` ASC
      LIMIT 100
    `;
  const [bySubmitter, byExecutor, byChannel, byStatus] = await Promise.all([
    mysql.query(groupedSql('t.created_by_machine_id'), params),
    mysql.query(groupedSql('t.target_machine_id'), params),
    mysql.query(groupedSql("CONCAT(t.channel, '.', t.provider, '/', t.task_type)"), params),
    mysql.query(groupedSql('t.status'), params),
  ]);
  const summary = mapCountRow({ key: 'all', ...(Array.isArray(summaryRows) && summaryRows[0] ? summaryRows[0] : {}) });
  return {
    filters: { days: safeDays, machineId: normalizedMachineId || null },
    summary,
    bySubmitter: (Array.isArray(bySubmitter) ? bySubmitter : []).map(mapCountRow),
    byExecutor: (Array.isArray(byExecutor) ? byExecutor : []).map(mapCountRow),
    byChannel: (Array.isArray(byChannel) ? byChannel : []).map(mapCountRow),
    byStatus: (Array.isArray(byStatus) ? byStatus : []).map(mapCountRow),
    usage: {
      available: false,
      note: 'Provider token/credit/cost extraction is not connected yet; current stats cover task, run, and output counts.',
    },
  };
}

async function listAdminBatches({ limit = 50, machineId = '', status = '' }) {
  await ensureSchema();
  const clauses = ['1=1'];
  const params = [];
  if (machineId) {
    clauses.push('target_machine_id = ?');
    params.push(machineId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const rows = await mysql.query(
    `
      SELECT *
      FROM task_batches
      WHERE ${clauses.join(' AND ')}
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `,
    params,
  );
  const out = [];
  for (const row of rows) {
    const batch = await getClientTaskBatch({
      machineId: String(row.target_machine_id),
      batchId: String(row.id),
    });
    if (batch) out.push(batch);
  }
  return out;
}

async function cancelTaskByAdmin({ taskId, actorId }) {
  await ensureSchema();
  return mysql.transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]);
    const task = Array.isArray(rows) ? rows[0] : null;
    if (!task) throw new Error('task not found');
    const seedanceRemoteId = String(task.channel || '').trim().toLowerCase() === 'seedance'
      ? seedanceRemoteIdFromResultPayload(task.result_payload_json)
      : null;
    if (seedanceRemoteId) {
      throw new Error(`Seedance 任务已存在远端 ID ${seedanceRemoteId}，为避免重复扣费，已禁止直接重试。请先确认远端任务状态。`);
    }
    const before = mapTaskRow(task);
    if (task.status === 'queued') {
      await conn.execute(
        `
          UPDATE tasks
          SET status = 'cancelled',
              error_class = 'cancelled',
              error_code = 'cancelled_by_admin',
              error_message = 'Cancelled by admin',
              updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = ?
        `,
        [taskId],
      );
    } else if (task.status === 'running') {
      await conn.execute(
        `
          UPDATE tasks
          SET status = 'cancel_requested',
              cancel_requested_at = CURRENT_TIMESTAMP(3),
              updated_at = CURRENT_TIMESTAMP(3)
          WHERE id = ?
        `,
        [taskId],
      );
    }
    await refreshBatchStatus(String(task.batch_id), conn);
    const after = await getClientTask({
      machineId: String(task.target_machine_id),
      taskId: String(task.id),
      conn,
    });
    await writeAuditLog({
      actorKind: 'admin',
      actorId,
      action: 'cancel_task',
      targetKind: 'task',
      targetId: String(task.id),
      before,
      after,
    });
    return after;
  });
}

async function retryTaskByAdmin({ taskId, actorId }) {
  await ensureSchema();
  return mysql.transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]);
    const task = Array.isArray(rows) ? rows[0] : null;
    if (!task) throw new Error('task not found');
    if (isSeedanceCreateUnknownTaskRow(task)) {
      throw new Error('该任务属于 Seedance 创建结果未知状态。请确认上游未成功创建后，再使用“确认未创建后重跑”以避免重复计费。');
    }
    const before = mapTaskRow(task);
    await requeueTaskById(conn, taskId);
    await refreshBatchStatus(String(task.batch_id), conn);
    const after = await getClientTask({
      machineId: String(task.target_machine_id),
      taskId: String(task.id),
      conn,
    });
    await writeAuditLog({
      actorKind: 'admin',
      actorId,
      action: 'retry_task',
      targetKind: 'task',
      targetId: String(task.id),
      before,
      after,
    });
    return after;
  });
}

async function retrySeedanceUnknownTaskByAdmin({ taskId, actorId }) {
  await ensureSchema();
  return mysql.transaction(async (conn) => {
    const [rows] = await conn.execute(`SELECT * FROM tasks WHERE id = ? LIMIT 1`, [taskId]);
    const task = Array.isArray(rows) ? rows[0] : null;
    if (!task) throw new Error('task not found');
    if (!isSeedanceCreateUnknownTaskRow(task)) {
      throw new Error('该任务不是 Seedance 创建结果未知状态，不能使用此人工重跑入口。');
    }
    const before = mapTaskRow(task);
    await requeueTaskById(conn, taskId);
    await refreshBatchStatus(String(task.batch_id), conn);
    const after = await getClientTask({
      machineId: String(task.target_machine_id),
      taskId: String(task.id),
      conn,
    });
    await writeAuditLog({
      actorKind: 'admin',
      actorId,
      action: 'retry_seedance_unknown_task',
      targetKind: 'task',
      targetId: String(task.id),
      before,
      after,
    });
    return after;
  });
}

module.exports = {
  DEFAULT_ACCOUNT_MAX_CONCURRENCY,
  DEFAULT_IMAGE_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STORAGE_ROOT_KEY,
  DEFAULT_VIDEO_TIMEOUT,
  MAX_ACCOUNT_MAX_CONCURRENCY,
  bootstrapLegacyMirror,
  cancelTaskByAdmin,
  createClientTaskBatch,
  ensureSchema,
  getClientTask,
  getClientTaskBatch,
  getAdminTaskStats,
  listClientTaskBatches,
  listExecutorMachines,
  listAccountControls,
  listAdminBatches,
  listAdminTasks,
  deleteMirroredAccount,
  mirrorAccountStorageState,
  mirrorStoreSnapshot,
  registerClientAsset,
  retrySeedanceUnknownTaskByAdmin,
  retryTaskByAdmin,
  syncControlPlaneSnapshot,
  upsertAccountControl,
};
