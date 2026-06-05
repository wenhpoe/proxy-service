const test = require('node:test');
const assert = require('node:assert/strict');

const {
  catalogToRows,
  rowsToCatalog,
} = require('../core/channelCatalogRows');

test('catalogToRows expands channels and providers into normalized row sets', () => {
  const payload = {
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '2',
        priority: 200,
        capabilities: { image_to_image: true },
        default_params: { params: { model: 'dreamina-seedance-2-0-fast-260128' } },
        client_options: { sizes: ['9:16'] },
        constraints: { requires_image: true },
        providers: [
          {
            key: '1',
            label: '服务商 1',
            enabled: true,
            runner_key: 'seedance.provider1',
            extra: { constraints: { requires_image: true } },
          },
          {
            key: '2',
            label: '服务商 2 (BytePlus)',
            enabled: true,
            runner_key: 'seedance.provider2',
            extra: { constraints: { requires_image: false } },
          },
        ],
      },
    ],
  };

  const { channelRows, providerRows } = catalogToRows(payload);

  assert.equal(channelRows.length, 1);
  assert.equal(channelRows[0].channel_key, 'seedance');
  assert.equal(channelRows[0].selected_provider_key, '2');
  assert.equal(providerRows.length, 2);
  assert.equal(providerRows[1].provider_key, '2');
  assert.equal(providerRows[1].runner_key, 'seedance.provider2');
  assert.equal(providerRows[1].config_json, JSON.stringify({ constraints: { requires_image: false } }));
});

test('rowsToCatalog rebuilds the existing catalog contract shape', () => {
  const catalog = rowsToCatalog({
    channelRows: [
      {
        channel_key: 'seedance',
        label: 'Seedance',
        enabled: 1,
        selected_provider_key: '2',
        priority: 200,
        capabilities_json: JSON.stringify({ image_to_image: true }),
        default_params_json: JSON.stringify({ params: { model: 'dreamina-seedance-2-0-fast-260128' } }),
        client_options_json: JSON.stringify({ sizes: ['9:16'] }),
        constraints_json: JSON.stringify({ requires_image: true }),
      },
    ],
    providerRows: [
      {
        channel_key: 'seedance',
        provider_key: '1',
        label: '服务商 1',
        enabled: 1,
        runner_key: 'seedance.provider1',
        base_url: 'https://testapi.genvia.ai',
        model: 'dreamina-seedance-2-0-260128',
        config_json: null,
      },
      {
        channel_key: 'seedance',
        provider_key: '2',
        label: '服务商 2 (BytePlus)',
        enabled: 1,
        runner_key: 'seedance.provider2',
        base_url: 'https://ark.ap-southeast.bytepluses.com',
        model: 'dreamina-seedance-2-0-260128',
        config_json: JSON.stringify({ constraints: { requires_image: false } }),
      },
    ],
  });

  assert.equal(catalog.version, 2);
  assert.equal(catalog.channels[0].selected_provider, '2');
  assert.equal(catalog.channels[0].providers[1].runner_key, 'seedance.provider2');
  assert.deepEqual(catalog.channels[0].providers[1].extra, {
    constraints: { requires_image: false },
  });
});
