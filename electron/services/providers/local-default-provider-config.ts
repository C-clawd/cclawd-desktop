import type { ProviderAccount } from '../../shared/providers/types';
import { getProviderDefinition } from '../../shared/providers/registry';
import type { OpenClawEnvEntry } from '../../utils/openclaw-env';
import { readOpenClawEnv } from '../../utils/openclaw-env';

const DEFAULT_PROVIDER_ENV_PREFIX = 'CCLAWD_DEFAULT_AI_';
type EnvRecord = Record<string, string | undefined>;

export interface LocalDefaultProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  apiKey: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
}

function entriesToEnvRecord(entries: OpenClawEnvEntry[]): EnvRecord {
  const result: EnvRecord = {};
  for (const entry of entries) {
    if (result[entry.key] === undefined) {
      result[entry.key] = entry.value;
    }
  }
  return result;
}

function readEnvValue(source: EnvRecord, key: string): string | undefined {
  const value = source[key]?.trim();
  return value || undefined;
}

function createConfigReader(openClawEnvEntries: OpenClawEnvEntry[], environment: EnvRecord): (name: string) => string | undefined {
  const envFile = entriesToEnvRecord(openClawEnvEntries);
  return (name: string) => {
    const key = `${DEFAULT_PROVIDER_ENV_PREFIX}${name}`;
    return readEnvValue(environment, key) || readEnvValue(envFile, key);
  };
}

function parseApiProtocol(value: string | undefined): LocalDefaultProviderConfig['api'] | undefined {
  if (
    value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
  ) {
    return value;
  }
  return undefined;
}

function parseHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const [key, headerValue] of Object.entries(parsed)) {
      if (typeof headerValue === 'string') {
        headers[key] = headerValue;
      }
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
  } catch {
    return undefined;
  }
}

export function resolveLocalDefaultProviderConfigFromSources(
  openClawEnvEntries: OpenClawEnvEntry[] = [],
  environment: EnvRecord = process.env,
): LocalDefaultProviderConfig | null {
  const readConfig = createConfigReader(openClawEnvEntries, environment);
  const provider = readConfig('PROVIDER');
  const apiKey = readConfig('API_KEY');
  if (!provider || !apiKey) {
    return null;
  }

  const definition = getProviderDefinition(provider);
  const providerConfig = definition?.providerConfig;
  const model = readConfig('MODEL') || definition?.defaultModelId;
  const baseUrl = readConfig('BASE_URL') || providerConfig?.baseUrl;
  const api = parseApiProtocol(readConfig('API')) || providerConfig?.api;

  if (!model || !baseUrl || !api) {
    return null;
  }

  return {
    provider,
    model,
    baseUrl,
    api,
    apiKey,
    apiKeyEnv: readConfig('API_KEY_ENV') || providerConfig?.apiKeyEnv || 'CCLAWD_DEFAULT_AI_API_KEY',
    headers: parseHeaders(readConfig('HEADERS')) || providerConfig?.headers,
  };
}

export async function resolveLocalDefaultProviderConfig(): Promise<LocalDefaultProviderConfig | null> {
  const { entries } = await readOpenClawEnv();
  return resolveLocalDefaultProviderConfigFromSources(entries);
}

export async function hasLocalDefaultProviderConfig(): Promise<boolean> {
  return (await resolveLocalDefaultProviderConfig()) !== null;
}

export function describeLocalDefaultProvider(config: LocalDefaultProviderConfig): Pick<ProviderAccount, 'baseUrl' | 'apiProtocol' | 'headers' | 'model'> {
  return {
    baseUrl: config.baseUrl,
    apiProtocol: config.api,
    headers: config.headers,
    model: config.model,
  };
}
