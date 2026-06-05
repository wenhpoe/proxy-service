const mysqlCtl = require('./mysql');
const { catalogToRows, rowsToCatalog } = require('./channelCatalogRows');

function createChannelCatalogStore({ mysqlGateway = mysqlCtl } = {}) {
  let schemaReady = false;

  async function ensureSchema() {
    if (schemaReady) return;
    if (!mysqlGateway.isEnabled()) throw new Error('mysql disabled');

    await mysqlGateway.withConnection(async (conn) => {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS request_channels (
          channel_key VARCHAR(64) PRIMARY KEY,
          label VARCHAR(255) NOT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          selected_provider_key VARCHAR(64) NOT NULL DEFAULT '1',
          priority INT NOT NULL DEFAULT 1000,
          capabilities_json JSON NULL,
          default_params_json JSON NULL,
          client_options_json JSON NULL,
          constraints_json JSON NULL,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      await conn.query(`
        CREATE TABLE IF NOT EXISTS request_channel_providers (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          channel_key VARCHAR(64) NOT NULL,
          provider_key VARCHAR(64) NOT NULL,
          label VARCHAR(255) NOT NULL,
          enabled TINYINT(1) NOT NULL DEFAULT 1,
          runner_key VARCHAR(128) NOT NULL,
          base_url VARCHAR(1024) NULL,
          model VARCHAR(255) NULL,
          config_json JSON NULL,
          updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          UNIQUE KEY uniq_channel_provider (channel_key, provider_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    });

    schemaReady = true;
  }

  async function isEmpty() {
    await ensureSchema();
    return mysqlGateway.withConnection(async (conn) => {
      const [rows] = await conn.query(`SELECT channel_key FROM request_channels LIMIT 1`);
      return !Array.isArray(rows) || rows.length === 0;
    });
  }

  async function loadCatalog() {
    await ensureSchema();
    return mysqlGateway.withConnection(async (conn) => {
      const [channelRows] = await conn.query(
        `SELECT * FROM request_channels ORDER BY priority ASC, channel_key ASC`,
      );
      const [providerRows] = await conn.query(
        `SELECT * FROM request_channel_providers ORDER BY channel_key ASC, provider_key ASC`,
      );
      return rowsToCatalog({ channelRows, providerRows });
    });
  }

  async function saveCatalog(payload) {
    await ensureSchema();
    const { channelRows, providerRows } = catalogToRows(payload);

    await mysqlGateway.transaction(async (conn) => {
      await conn.execute(`DELETE FROM request_channel_providers`);
      await conn.execute(`DELETE FROM request_channels`);

      for (const row of channelRows) {
        await conn.execute(
          `INSERT INTO request_channels (
            channel_key,
            label,
            enabled,
            selected_provider_key,
            priority,
            capabilities_json,
            default_params_json,
            client_options_json,
            constraints_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.channel_key,
            row.label,
            row.enabled,
            row.selected_provider_key,
            row.priority,
            row.capabilities_json,
            row.default_params_json,
            row.client_options_json,
            row.constraints_json,
          ],
        );
      }

      for (const row of providerRows) {
        await conn.execute(
          `INSERT INTO request_channel_providers (
            channel_key,
            provider_key,
            label,
            enabled,
            runner_key,
            base_url,
            model,
            config_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.channel_key,
            row.provider_key,
            row.label,
            row.enabled,
            row.runner_key,
            row.base_url,
            row.model,
            row.config_json,
          ],
        );
      }
    });

    return loadCatalog();
  }

  async function bootstrapFromCatalogIfEmpty(payload) {
    if (!(await isEmpty())) return loadCatalog();
    return saveCatalog(payload);
  }

  return {
    bootstrapFromCatalogIfEmpty,
    ensureSchema,
    isEmpty,
    loadCatalog,
    saveCatalog,
  };
}

module.exports = {
  createChannelCatalogStore,
};
