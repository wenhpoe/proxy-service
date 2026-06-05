const test = require('node:test');
const assert = require('node:assert/strict');

const { createChannelCatalogStore } = require('../core/channelCatalogStore');

function makeFakeMysql({ channelRows = [], providerRows = [] } = {}) {
  const state = {
    channelRows: [...channelRows],
    providerRows: [...providerRows],
    executed: [],
  };

  const conn = {
    async query(sql) {
      state.executed.push(sql);
      if (sql.includes('FROM request_channels')) return [state.channelRows];
      if (sql.includes('FROM request_channel_providers')) return [state.providerRows];
      return [[]];
    },
    async execute(sql, params = []) {
      state.executed.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
  };

  return {
    state,
    isEnabled: () => true,
    withConnection: async (fn) => fn(conn),
    transaction: async (fn) => fn(conn),
  };
}

test('bootstrapFromCatalogIfEmpty seeds empty mysql tables from a file catalog', async () => {
  const fakeMysql = makeFakeMysql();
  const store = createChannelCatalogStore({ mysqlGateway: fakeMysql });

  await store.bootstrapFromCatalogIfEmpty({
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '2',
        providers: [
          { key: '1', label: '服务商 1', enabled: true, runner_key: 'seedance.provider1' },
          { key: '2', label: '服务商 2', enabled: true, runner_key: 'seedance.provider2' },
        ],
      },
    ],
  });

  assert.ok(
    fakeMysql.state.executed.some((entry) => String(entry.sql || entry).includes('INSERT INTO request_channels')),
    'expected request_channels insert',
  );
  assert.ok(
    fakeMysql.state.executed.some((entry) => String(entry.sql || entry).includes('INSERT INTO request_channel_providers')),
    'expected request_channel_providers insert',
  );
});

test('loadCatalog rebuilds catalog from mysql rows', async () => {
  const fakeMysql = makeFakeMysql({
    channelRows: [
      {
        channel_key: 'seedance',
        label: 'Seedance',
        enabled: 1,
        selected_provider_key: '2',
        priority: 200,
        capabilities_json: '{}',
        default_params_json: '{}',
        client_options_json: '{}',
        constraints_json: '{}',
      },
    ],
    providerRows: [
      {
        channel_key: 'seedance',
        provider_key: '2',
        label: '服务商 2',
        enabled: 1,
        runner_key: 'seedance.provider2',
        base_url: 'https://ark.ap-southeast.bytepluses.com',
        model: 'dreamina-seedance-2-0-260128',
        config_json: '{}',
      },
    ],
  });
  const store = createChannelCatalogStore({ mysqlGateway: fakeMysql });

  const catalog = await store.loadCatalog();

  assert.equal(catalog.channels[0].selected_provider, '2');
  assert.equal(catalog.channels[0].providers[0].runner_key, 'seedance.provider2');
});
