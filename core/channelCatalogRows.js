const {
  CHANNEL_CONFIG_SCHEMA_VERSION,
  normalizeChannelConfig,
} = require('./channelConfig');

function safeJsonParse(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function toJsonText(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {});
}

function toOptionalJsonText(value) {
  if (!value || typeof value !== 'object') return null;
  return JSON.stringify(value);
}

function toNumberOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function catalogToRows(payload) {
  const catalog = normalizeChannelConfig(payload);
  const channelRows = [];
  const providerRows = [];

  for (const channel of catalog.channels) {
    channelRows.push({
      channel_key: channel.key,
      label: channel.label,
      enabled: channel.enabled !== false ? 1 : 0,
      selected_provider_key: String(channel.selected_provider || '1'),
      priority: toNumberOr(channel.priority, 1000),
      capabilities_json: toJsonText(channel.capabilities),
      default_params_json: toJsonText(channel.default_params),
      client_options_json: toJsonText(channel.client_options),
      constraints_json: toJsonText(channel.constraints),
    });

    for (const provider of Array.isArray(channel.providers) ? channel.providers : []) {
      providerRows.push({
        channel_key: channel.key,
        provider_key: String(provider.key || '1'),
        label: String(provider.label || provider.key || '1'),
        enabled: provider.enabled !== false ? 1 : 0,
        runner_key: String(provider.runner_key || '').trim(),
        base_url: provider.base_url ? String(provider.base_url) : null,
        model: provider.model ? String(provider.model) : null,
        config_json: toOptionalJsonText(provider.extra),
      });
    }
  }

  return {
    version: CHANNEL_CONFIG_SCHEMA_VERSION,
    channelRows,
    providerRows,
  };
}

function rowsToCatalog({ channelRows = [], providerRows = [] } = {}) {
  const providersByChannel = new Map();

  for (const row of providerRows) {
    const channelKey = String(row.channel_key || '').trim().toLowerCase();
    if (!channelKey) continue;
    if (!providersByChannel.has(channelKey)) providersByChannel.set(channelKey, []);

    const extra = safeJsonParse(row.config_json, null);
    const provider = {
      key: String(row.provider_key || '1'),
      label: String(row.label || row.provider_key || '1'),
      enabled: Number(row.enabled) !== 0,
      runner_key: String(row.runner_key || '').trim() || undefined,
      base_url: row.base_url ? String(row.base_url) : undefined,
      model: row.model ? String(row.model) : undefined,
    };
    if (extra && typeof extra === 'object') provider.extra = extra;
    providersByChannel.get(channelKey).push(provider);
  }

  const channels = channelRows
    .map((row) => {
      const channelKey = String(row.channel_key || '').trim().toLowerCase();
      if (!channelKey) return null;
      return {
        key: channelKey,
        label: String(row.label || row.channel_key || '').trim() || channelKey,
        enabled: Number(row.enabled) !== 0,
        selected_provider: String(row.selected_provider_key || '1'),
        priority: toNumberOr(row.priority, 1000),
        capabilities: safeJsonParse(row.capabilities_json, {}),
        default_params: safeJsonParse(row.default_params_json, {}),
        client_options: safeJsonParse(row.client_options_json, {}),
        constraints: safeJsonParse(row.constraints_json, {}),
        providers: providersByChannel.get(channelKey) || [],
      };
    })
    .filter(Boolean);

  return normalizeChannelConfig({
    version: CHANNEL_CONFIG_SCHEMA_VERSION,
    channels,
  });
}

module.exports = {
  catalogToRows,
  rowsToCatalog,
};
