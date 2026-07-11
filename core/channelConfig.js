const fs = require('fs');
const path = require('path');

const CHANNEL_CONFIG_SCHEMA_VERSION = 2;

const DEFAULT_CHANNEL_CONFIG = {
  version: CHANNEL_CONFIG_SCHEMA_VERSION,
  channels: [
    {
      key: 'flow',
      label: 'Flow',
      enabled: true,
      selected_provider: '1',
      priority: 100,
      capabilities: {
        image_to_image: true,
        text_to_image: true,
        upsample: true,
        download: true,
      },
      default_params: {
        params: {
          channel_options: {
            model_name: 'GEM_PIX_2',
            aspect_ratio: 'IMAGE_ASPECT_RATIO_PORTRAIT',
          },
        },
      },
      constraints: {},
      providers: [
        {
          key: '1',
          label: '服务商 1',
          enabled: true,
          runner_key: 'flow.provider1',
        },
      ],
    },
    {
      key: 'seedance',
      label: 'Seedance',
      enabled: true,
      selected_provider: '3',
      priority: 200,
      capabilities: {
        image_to_image: true,
        text_to_image: false,
        upsample: false,
        download: true,
      },
      default_params: {
        params: {
          model: 'dreamina-seedance-2-0-fast-260128',
          size: '9:16',
          seconds: 5,
          extra_body: {
            resolution: '720p',
          },
        },
      },
      client_options: {
        models: [
          'dreamina-seedance-2-0-fast-260128',
          'dreamina-seedance-2-0-260128',
        ],
        sizes: ['16:9', '9:16', '1:1', '3:4', '4:3'],
        seconds: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
        resolutions: ['480p', '720p', '1080p'],
      },
      constraints: {
        requires_image: true,
      },
      providers: [
        {
          key: '1',
          label: '服务商 1',
          enabled: true,
          runner_key: 'seedance.provider1',
          base_url: 'https://testapi.genvia.ai',
          model: 'dreamina-seedance-2-0-260128',
          extra: {
            constraints: {
              requires_image: true,
            },
          },
        },
        {
          key: '2',
          label: '服务商 2 (BytePlus)',
          enabled: true,
          runner_key: 'seedance.provider2',
          base_url: 'https://ark.ap-southeast.bytepluses.com',
          model: 'dreamina-seedance-2-0-260128',
          extra: {
            constraints: {
              requires_image: false,
            },
          },
        },
        {
          key: '3',
          label: '服务商 3 (Morerouter)',
          enabled: true,
          runner_key: 'seedance.provider3',
          base_url: 'https://morerouter.com/api/v3',
          model: 'dreamina-seedance-2-0-fast-260128',
          extra: {
            constraints: {
              requires_image: false,
            },
          },
        },
      ],
    },
  ],
};

function safeJsonParseText(text, fallback = null) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return fallback;
  }
}

function cloneJson(value) {
  return safeJsonParseText(JSON.stringify(value), value);
}

function normalizeProviderConfig(provider, fallbackKey = '1') {
  const raw = provider && typeof provider === 'object' ? provider : {};
  const key = String(raw.key || raw.id || fallbackKey).trim() || fallbackKey;
  const extra = raw.extra && typeof raw.extra === 'object' ? { ...raw.extra } : undefined;
  const directConstraints = raw.constraints && typeof raw.constraints === 'object' ? raw.constraints : undefined;
  let mergedExtra = extra;
  if (directConstraints && Object.keys(directConstraints).length) {
    mergedExtra = extra || {};
    mergedExtra.constraints = {
      ...(mergedExtra.constraints && typeof mergedExtra.constraints === 'object' ? mergedExtra.constraints : {}),
      ...directConstraints,
    };
  }
  return {
    key,
    label: String(raw.label || `服务商 ${key}`).trim() || `服务商 ${key}`,
    enabled: raw.enabled !== false,
    runner_key: raw.runner_key ? String(raw.runner_key).trim() : undefined,
    base_url: raw.base_url ? String(raw.base_url).trim() : undefined,
    model: raw.model ? String(raw.model).trim() : undefined,
    api_key: raw.api_key ? String(raw.api_key).trim() : undefined,
    extra: mergedExtra,
  };
}

function normalizeStringList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/g)
      : fallback;
  return Array.from(new Set(
    source
      .map((item) => String(item || '').trim())
      .filter(Boolean),
  ));
}

function normalizeNumberList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/g)
      : fallback;
  return Array.from(new Set(
    source
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0)
      .map((item) => Math.round(item)),
  ));
}

function normalizeChannelClientOptions(value, fallback = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const source = Object.keys(raw).length ? raw : fallback;
  const out = {};
  const models = normalizeStringList(source.models, []);
  const sizes = normalizeStringList(source.sizes, []);
  const seconds = normalizeNumberList(source.seconds, []);
  const resolutions = normalizeStringList(source.resolutions, []);
  if (models.length) out.models = models;
  if (sizes.length) out.sizes = sizes;
  if (seconds.length) out.seconds = seconds;
  if (resolutions.length) out.resolutions = resolutions;
  return out;
}

function mergeProviderConfigs(rawProviders, fallbackProviders) {
  const rawList = Array.isArray(rawProviders) ? rawProviders : [];
  const fallbackList = Array.isArray(fallbackProviders) ? fallbackProviders : [];
  const fallbackByKey = new Map(
    fallbackList.map((provider, index) => {
      const normalized = normalizeProviderConfig(provider, String(index + 1));
      return [normalized.key, normalized];
    }),
  );
  const merged = [];
  const seen = new Set();

  for (const [index, provider] of rawList.entries()) {
    const raw = provider && typeof provider === 'object' ? provider : {};
    const rawKey = String(raw.key || raw.id || '').trim();
    const fallbackProvider = rawKey ? fallbackByKey.get(rawKey) : null;
    const normalized = normalizeProviderConfig(
      fallbackProvider ? { ...fallbackProvider, ...raw } : raw,
      String(index + 1),
    );
    if (seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    merged.push(normalized);
  }

  for (const [index, provider] of fallbackList.entries()) {
    const normalized = normalizeProviderConfig(provider, String(index + 1));
    if (seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    merged.push(normalized);
  }

  return merged.length ? merged : [normalizeProviderConfig({}, '1')];
}

function resolveSelectedProvider({
  rawVersion,
  selectedProviderRaw,
  providers,
  enabledProviders,
  fallbackChannel,
}) {
  const fallbackSelectedProviderRaw = String(fallbackChannel.selected_provider || '').trim();
  const fallbackSelectedProvider =
    (fallbackSelectedProviderRaw && providers.find((provider) => provider.key === fallbackSelectedProviderRaw)?.key) ||
    enabledProviders[0]?.key ||
    providers[0]?.key ||
    '1';
  const legacyDefaultProviderKey = Array.isArray(fallbackChannel.providers) && fallbackChannel.providers.length
    ? String(fallbackChannel.providers[0]?.key || '').trim()
    : '';
  const shouldPromoteFallbackSelection =
    Number.isFinite(rawVersion) &&
    rawVersion < CHANNEL_CONFIG_SCHEMA_VERSION &&
    selectedProviderRaw &&
    legacyDefaultProviderKey &&
    fallbackSelectedProvider &&
    selectedProviderRaw === legacyDefaultProviderKey &&
    selectedProviderRaw !== fallbackSelectedProvider;

  if (shouldPromoteFallbackSelection) return fallbackSelectedProvider;
  return (
    (selectedProviderRaw && providers.find((provider) => provider.key === selectedProviderRaw)?.key) ||
    fallbackSelectedProvider
  );
}

function normalizeChannelConfig(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const rawVersion = Number(raw.version);
  const fallback = cloneJson(DEFAULT_CHANNEL_CONFIG);
  const sourceChannels = Array.isArray(raw.channels) && raw.channels.length ? raw.channels : fallback.channels;
  const channels = sourceChannels
    .map((channel, index) => {
      const item = channel && typeof channel === 'object' ? channel : {};
      const key = String(item.key || item.channel || '').trim().toLowerCase();
      if (!key) return null;
      const fallbackChannel = fallback.channels.find((it) => it.key === key) || {};
      const providers = mergeProviderConfigs(item.providers, fallbackChannel.providers);
      const enabledProviders = providers.filter((provider) => provider.enabled !== false);
      const selectedProviderRaw = String(item.selected_provider || item.selectedProvider || '').trim();
      const selectedProvider = resolveSelectedProvider({
        rawVersion,
        selectedProviderRaw,
        providers,
        enabledProviders,
        fallbackChannel,
      });
      const defaultParams =
        item.default_params && typeof item.default_params === 'object' && Object.keys(item.default_params).length
          ? item.default_params
          : (fallbackChannel.default_params || {});
      return {
        key,
        label: String(item.label || fallbackChannel.label || key).trim() || key,
        enabled: item.enabled !== false,
        selected_provider: selectedProvider,
        providers,
        priority: Number.isFinite(Number(item.priority))
          ? Number(item.priority)
          : Number.isFinite(Number(fallbackChannel.priority))
            ? Number(fallbackChannel.priority)
            : undefined,
        capabilities:
          item.capabilities && typeof item.capabilities === 'object' && Object.keys(item.capabilities).length
            ? item.capabilities
            : (fallbackChannel.capabilities || {}),
        default_params: defaultParams,
        client_options: normalizeChannelClientOptions(item.client_options, fallbackChannel.client_options || {}),
        constraints:
          item.constraints && typeof item.constraints === 'object' && Object.keys(item.constraints).length
            ? item.constraints
            : (fallbackChannel.constraints || {}),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
    .map(({ order, ...rest }) => rest);
  return {
    version: Number.isFinite(rawVersion)
      ? Math.max(rawVersion, CHANNEL_CONFIG_SCHEMA_VERSION)
      : CHANNEL_CONFIG_SCHEMA_VERSION,
    channels,
  };
}

function readChannelConfigFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = safeJsonParseText(fs.readFileSync(filePath, 'utf8'), null);
      if (parsed && typeof parsed === 'object') return normalizeChannelConfig(parsed);
    }
  } catch {
    // ignore
  }
  return normalizeChannelConfig(DEFAULT_CHANNEL_CONFIG);
}

function writeChannelConfigFile(filePath, config) {
  const normalized = normalizeChannelConfig(config);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function buildClientChannelCatalog(config) {
  const normalized = normalizeChannelConfig(config);
  return {
    version: normalized.version,
    channels: normalized.channels
      .filter((channel) => channel.enabled !== false)
      .map((channel) => ({
        key: channel.key,
        label: channel.label,
        enabled: true,
        selected_provider: channel.selected_provider,
        providers: channel.providers.filter((provider) => provider.enabled !== false).map((provider) => ({
          key: provider.key,
          label: provider.label,
          enabled: true,
          base_url: provider.base_url || undefined,
          constraints:
            provider.extra && typeof provider.extra === 'object' && provider.extra.constraints && typeof provider.extra.constraints === 'object'
              ? provider.extra.constraints
              : undefined,
        })),
        capabilities: channel.capabilities || {},
        constraints: channel.constraints || {},
        default_params: channel.default_params || {},
        client_options: channel.client_options || {},
      })),
  };
}

module.exports = {
  CHANNEL_CONFIG_SCHEMA_VERSION,
  DEFAULT_CHANNEL_CONFIG,
  buildClientChannelCatalog,
  normalizeChannelConfig,
  readChannelConfigFile,
  writeChannelConfigFile,
};
