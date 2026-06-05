const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CHANNEL_CONFIG,
  buildClientChannelCatalog,
  normalizeChannelConfig,
} = require('../core/channelConfig');

test('buildClientChannelCatalog exposes provider-level constraints for seedance', () => {
  const catalog = buildClientChannelCatalog(DEFAULT_CHANNEL_CONFIG);
  const seedance = catalog.channels.find((channel) => channel.key === 'seedance');

  assert.ok(seedance, 'expected seedance channel in client catalog');
  assert.deepEqual(
    seedance.providers.map((provider) => [provider.key, provider.constraints?.requires_image]),
    [['1', true], ['2', false]],
  );
});

test('normalizeChannelConfig lifts direct provider constraints into extra config', () => {
  const normalized = normalizeChannelConfig({
    version: 2,
    channels: [
      {
        key: 'seedance',
        label: 'Seedance',
        enabled: true,
        selected_provider: '2',
        constraints: { requires_image: true },
        providers: [
          {
            key: '2',
            label: '服务商 2 (BytePlus)',
            enabled: true,
            runner_key: 'seedance.provider2',
            constraints: { requires_image: false },
          },
        ],
      },
    ],
  });

  assert.deepEqual(normalized.channels[0].providers[0].extra, {
    constraints: { requires_image: false },
  });
});
