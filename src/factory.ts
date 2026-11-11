import { ConfigError } from './errors.js';
import { PathaoCourier, type PathaoConfig } from './providers/pathao/client.js';
import { RedxCourier, type RedxConfig } from './providers/redx/client.js';
import { SteadfastCourier, type SteadfastConfig } from './providers/steadfast/client.js';
import { PROVIDERS, type ProviderName } from './types.js';

export interface ProviderConfigMap {
  pathao: PathaoConfig;
  steadfast: SteadfastConfig;
  redx: RedxConfig;
}

export interface ProviderClientMap {
  pathao: PathaoCourier;
  steadfast: SteadfastCourier;
  redx: RedxCourier;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Environment variables read by {@link configFromEnv} and the CLI. */
export const ENV_VARS = {
  pathao: {
    required: ['PATHAO_CLIENT_ID', 'PATHAO_CLIENT_SECRET', 'PATHAO_USERNAME', 'PATHAO_PASSWORD'],
    optional: ['PATHAO_STORE_ID', 'PATHAO_SANDBOX', 'PATHAO_BASE_URL'],
  },
  steadfast: {
    required: ['STEADFAST_API_KEY', 'STEADFAST_SECRET_KEY'],
    optional: ['STEADFAST_BASE_URL'],
  },
  redx: {
    required: ['REDX_ACCESS_TOKEN'],
    optional: ['REDX_PICKUP_STORE_ID', 'REDX_PICKUP_AREA_ID', 'REDX_SANDBOX', 'REDX_BASE_URL'],
  },
} as const satisfies Record<ProviderName, { required: readonly string[]; optional: readonly string[] }>;

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function flag(env: Env, key: string): boolean {
  const value = read(env, key)?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/** Build a provider config from environment variables. Throws {@link ConfigError} naming any missing variable. */
export function configFromEnv<P extends ProviderName>(provider: P, env: Env = process.env): ProviderConfigMap[P] {
  if (!isProviderName(provider)) {
    throw new ConfigError(`Unknown provider "${String(provider)}". Expected one of: ${PROVIDERS.join(', ')}`);
  }
  const missing = ENV_VARS[provider].required.filter((key) => read(env, key) === undefined);
  if (missing.length > 0) {
    throw new ConfigError(`[${provider}] missing environment variable(s): ${missing.join(', ')}`, { provider });
  }
  const get = (key: string): string => read(env, key) as string;
  switch (provider) {
    case 'pathao': {
      const config: PathaoConfig = {
        clientId: get('PATHAO_CLIENT_ID'),
        clientSecret: get('PATHAO_CLIENT_SECRET'),
        username: get('PATHAO_USERNAME'),
        password: get('PATHAO_PASSWORD'),
        sandbox: flag(env, 'PATHAO_SANDBOX'),
      };
      const storeId = read(env, 'PATHAO_STORE_ID');
      if (storeId !== undefined) config.storeId = storeId;
      const baseUrl = read(env, 'PATHAO_BASE_URL');
      if (baseUrl !== undefined) config.baseUrl = baseUrl;
      return config as ProviderConfigMap[P];
    }
    case 'steadfast': {
      const config: SteadfastConfig = { apiKey: get('STEADFAST_API_KEY'), secretKey: get('STEADFAST_SECRET_KEY') };
      const baseUrl = read(env, 'STEADFAST_BASE_URL');
      if (baseUrl !== undefined) config.baseUrl = baseUrl;
      return config as ProviderConfigMap[P];
    }
    default: {
      const config: RedxConfig = { accessToken: get('REDX_ACCESS_TOKEN'), sandbox: flag(env, 'REDX_SANDBOX') };
      const storeId = read(env, 'REDX_PICKUP_STORE_ID');
      if (storeId !== undefined) config.pickupStoreId = storeId;
      const areaId = read(env, 'REDX_PICKUP_AREA_ID');
      if (areaId !== undefined) config.pickupAreaId = areaId;
      const baseUrl = read(env, 'REDX_BASE_URL');
      if (baseUrl !== undefined) config.baseUrl = baseUrl;
      return config as ProviderConfigMap[P];
    }
  }
}

/** Create a courier client by provider name. */
export function createCourier<P extends ProviderName>(provider: P, config: ProviderConfigMap[P]): ProviderClientMap[P] {
  switch (provider) {
    case 'pathao':
      return new PathaoCourier(config as PathaoConfig) as ProviderClientMap[P];
    case 'steadfast':
      return new SteadfastCourier(config as SteadfastConfig) as ProviderClientMap[P];
    case 'redx':
      return new RedxCourier(config as RedxConfig) as ProviderClientMap[P];
    default:
      throw new ConfigError(`Unknown provider "${String(provider)}". Expected one of: ${PROVIDERS.join(', ')}`);
  }
}

/** Create a courier client from environment variables, with optional overrides (fetch, timeouts, ...). */
export function createCourierFromEnv<P extends ProviderName>(
  provider: P,
  env: Env = process.env,
  overrides: Partial<ProviderConfigMap[P]> = {},
): ProviderClientMap[P] {
  const config = { ...configFromEnv(provider, env), ...overrides } as ProviderConfigMap[P];
  return createCourier(provider, config);
}
