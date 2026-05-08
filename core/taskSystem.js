const crypto = require('crypto');

const mysql = require('./mysql');

const DEFAULT_WORKER_LIMIT = 7;
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

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function normalizeStorageRootKey(value) {
  const raw = String(value || '').trim();
  return raw || DEFAULT_STORAGE_ROOT_KEY;
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
        note TEXT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
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

async function mirrorStoreSnapshot(store) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const snapshot = store && typeof store === 'object' ? store : {};
  const profiles = snapshot.profiles && typeof snapshot.profiles === 'object' ? snapshot.profiles : {};
  const pool = Array.isArray(snapshot.pool) ? snapshot.pool : [];
  const machines = snapshot.machines && typeof snapshot.machines === 'object' ? snapshot.machines : {};
  const activationCodes = Array.isArray(snapshot.activationCodes) ? snapshot.activationCodes : [];

  await mysql.transaction(async (conn) => {
    const profileNames = Object.keys(profiles);
    if (profileNames.length) {
      for (const profileName of profileNames) {
        await conn.execute(
          `
            INSERT INTO cp_profiles (profile_name, config_json, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE
              config_json = VALUES(config_json),
              updated_at = CURRENT_TIMESTAMP(3)
          `,
          [profileName, safeJsonStringify(profiles[profileName] || {})],
        );
      }
      const placeholders = profileNames.map(() => '?').join(', ');
      await conn.execute(
        `DELETE FROM cp_profiles WHERE profile_name NOT IN (${placeholders})`,
        profileNames,
      );
    } else {
      await conn.execute('DELETE FROM cp_profiles');
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
            entry.activatedAt ? String(entry.activatedAt).slice(0, 26).replace('T', ' ') : null,
            entry.lastSeenAt ? String(entry.lastSeenAt).slice(0, 26).replace('T', ' ') : null,
            entry.resetAt ? String(entry.resetAt).slice(0, 26).replace('T', ' ') : null,
            Number.isFinite(workerLimit) && workerLimit > 0 ? Math.round(workerLimit) : DEFAULT_WORKER_LIMIT,
            safeJsonStringify(Array.isArray(entry.allowedProfiles) ? entry.allowedProfiles : []),
            entry.note ? String(entry.note) : null,
            safeJsonStringify(entry),
          ],
        );
      }
      const placeholders = machineIds.map(() => '?').join(', ');
      await conn.execute(`DELETE FROM cp_machines WHERE machine_id NOT IN (${placeholders})`, machineIds);
    } else {
      await conn.execute('DELETE FROM cp_machines');
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
  });
  return { ok: true };
}

async function mirrorAccountStorageState(profileName, storageState, { source = 'capture' } = {}) {
  if (!mysql.isEnabled()) return { ok: false, reason: 'mysql disabled' };
  await ensureSchema();
  const profile = String(profileName || '').trim();
  if (!profile) throw new Error('profile required');
  const payload = storageState && typeof storageState === 'object' ? storageState : {};
  await mysql.transaction(async (conn) => {
    await conn.execute(
      `
        INSERT INTO cp_accounts (profile_name, status, created_at, updated_at)
        VALUES (?, 'active', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          updated_at = CURRENT_TIMESTAMP(3)
      `,
      [profile],
    );
    const [rows] = await conn.execute(
      `SELECT version FROM cp_account_auth_states WHERE profile_name = ? LIMIT 1`,
      [profile],
    );
    const currentVersion = Array.isArray(rows) && rows[0] ? Number(rows[0].version || 0) : 0;
    const nextVersion = currentVersion + 1;
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
      [profile, safeJsonStringify(payload), nextVersion || 1, String(source || 'capture')],
    );
  });
  return { ok: true };
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
  const taskType = String(item.taskType || item.task_type || 'image').trim().toLowerCase();
  if (!['image', 'video'].includes(taskType)) throw new Error(`unsupported taskType: ${taskType}`);
  const prompt = String(item.prompt || '').trim();
  if (!prompt) throw new Error('prompt required');
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
    referenceAssetId: item.referenceAssetId ? String(item.referenceAssetId) : null,
    referenceAssetIds: Array.isArray(item.referenceAssetIds)
      ? item.referenceAssetIds.map((value) => String(value)).filter(Boolean)
      : [],
    modelName: item.modelName ? String(item.modelName) : null,
    aspectRatio: item.aspectRatio ? String(item.aspectRatio) : null,
    humanSpeedPreset: item.humanSpeedPreset ? String(item.humanSpeedPreset) : null,
    taskSettings: item.taskSettings && typeof item.taskSettings === 'object' ? item.taskSettings : {},
    outputSettings: item.outputSettings && typeof item.outputSettings === 'object' ? item.outputSettings : {},
  };
  return {
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

async function createClientTaskBatch({ machineId, body }) {
  await ensureSchema();
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

  return mysql.transaction(async (conn) => {
    const [existingRows] = await conn.execute(
      `
        SELECT id, status, target_machine_id, created_by_machine_id, priority, expire_at, created_at, updated_at
        FROM task_batches
        WHERE created_by_machine_id = ? AND idempotency_key = ?
        LIMIT 1
      `,
      [machineId, idempotencyKey],
    );
    if (Array.isArray(existingRows) && existingRows[0]) {
      return getClientTaskBatch({ machineId, batchId: String(existingRows[0].id), conn });
    }

    const batchId = makeId('batch');
    await conn.execute(
      `
        INSERT INTO task_batches
        (id, target_machine_id, created_by_machine_id, created_by_kind, idempotency_key, priority, status, expire_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `,
      [
        batchId,
        machineId,
        machineId,
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
      }),
    );
    for (const item of normalizedTasks) {
      const taskId = makeId('task');
      await conn.execute(
        `
          INSERT INTO tasks
          (id, batch_id, target_machine_id, created_by_machine_id, task_type, prompt, input_payload_json, required_account_profile, status, priority, attempt_count, max_attempts, next_retry_at, expire_at, run_timeout_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, CURRENT_TIMESTAMP(3), ?, ?)
        `,
        [
          taskId,
          batchId,
          machineId,
          machineId,
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
      actorId: machineId,
      action: 'create_batch',
      targetKind: 'task_batch',
      targetId: batchId,
      after: {
        batchId,
        taskCount: normalizedTasks.length,
        priority,
        expireAt: expireAt.toISOString(),
      },
    });
    return getClientTaskBatch({ machineId, batchId, conn });
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
        WHERE id = ? AND target_machine_id = ?
        LIMIT 1
      `,
      [taskId, machineId],
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
        WHERE id = ? AND target_machine_id = ?
        LIMIT 1
      `,
      [batchId, machineId],
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
    const before = mapTaskRow(task);
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

module.exports = {
  DEFAULT_IMAGE_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STORAGE_ROOT_KEY,
  DEFAULT_VIDEO_TIMEOUT,
  bootstrapLegacyMirror,
  cancelTaskByAdmin,
  createClientTaskBatch,
  ensureSchema,
  getClientTask,
  getClientTaskBatch,
  listAdminBatches,
  listAdminTasks,
  deleteMirroredAccount,
  mirrorAccountStorageState,
  mirrorStoreSnapshot,
  registerClientAsset,
  retryTaskByAdmin,
};
