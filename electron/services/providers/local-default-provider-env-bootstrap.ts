import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getProviderDefinition } from '../../shared/providers/registry';
import type { OpenClawEnvEntry } from '../../utils/openclaw-env';
import { readOpenClawEnv, writeOpenClawEnv } from '../../utils/openclaw-env';
import { getOpenClawProvidersConfig } from '../../utils/openclaw-auth';
import { getAliasSourceTypes } from '../../utils/provider-keys';
import { getResourcesDir } from '../../utils/paths';

const DEFAULT_AI_ENV_KEYS = [
  'CCLAWD_DEFAULT_AI_PROVIDER',
  'CCLAWD_DEFAULT_AI_MODEL',
  'CCLAWD_DEFAULT_AI_BASE_URL',
  'CCLAWD_DEFAULT_AI_API',
  'CCLAWD_DEFAULT_AI_API_KEY',
  'CCLAWD_DEFAULT_AI_API_KEY_ENV',
  'CCLAWD_DEFAULT_AI_HEADERS',
] as const;

type ApiProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages';

interface AuthProfileEntry {
  type?: string;
  provider?: string;
  key?: string;
}

interface AuthProfilesStore {
  profiles?: Record<string, AuthProfileEntry>;
  lastGood?: Record<string, string>;
}

interface DefaultAiProviderPreset {
  enabled?: boolean;
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  api?: unknown;
  apiKey?: unknown;
  apiKeyEnv?: unknown;
  headers?: unknown;
}

interface ResolvedDefaultAiProviderPreset {
  provider: string;
  model: string;
  baseUrl: string;
  api: ApiProtocol;
  apiKey: string;
  apiKeyEnv: string;
  headers?: Record<string, string>;
}

export interface DefaultProviderEnvBootstrapResult {
  status: 'configured' | 'already-configured' | 'skipped';
  source?: 'openclaw' | 'preset';
  reason?: string;
  provider?: string;
  model?: string;
}

function hasDefaultAiEnv(entries: OpenClawEnvEntry[]): boolean {
  const values = new Map(entries.map((entry) => [entry.key, entry.value.trim()]));
  return Boolean(values.get('CCLAWD_DEFAULT_AI_PROVIDER') && values.get('CCLAWD_DEFAULT_AI_API_KEY'));
}

function upsertEnvEntry(entries: OpenClawEnvEntry[], key: string, value: string): OpenClawEnvEntry[] {
  let updated = false;
  const nextEntries = entries.map((entry) => {
    if (entry.key !== key) {
      return entry;
    }
    updated = true;
    return { key, value };
  });

  if (!updated) {
    nextEntries.push({ key, value });
  }

  return nextEntries;
}

function removeEnvEntry(entries: OpenClawEnvEntry[], key: string): OpenClawEnvEntry[] {
  return entries.filter((entry) => entry.key !== key);
}

function parseModelRef(modelRef: string | undefined): { providerKey: string; model: string } | null {
  const trimmed = modelRef?.trim();
  if (!trimmed || !trimmed.includes('/')) {
    return null;
  }
  const slash = trimmed.indexOf('/');
  const providerKey = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!providerKey || !model) {
    return null;
  }
  return { providerKey, model };
}

function parseApi(value: unknown): ApiProtocol | null {
  if (
    value === 'openai-completions'
    || value === 'openai-responses'
    || value === 'anthropic-messages'
  ) {
    return value;
  }
  return null;
}

function resolveLocalProviderType(providerKey: string): string {
  if (providerKey.startsWith('custom-')) {
    return 'custom';
  }
  if (providerKey.startsWith('ollama-')) {
    return 'ollama';
  }
  if (getProviderDefinition(providerKey)) {
    return providerKey;
  }
  const aliasSource = getAliasSourceTypes(providerKey)[0];
  return aliasSource ?? providerKey;
}

function resolveHeaders(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') {
      headers[key] = headerValue;
    }
  }
  return Object.keys(headers).length > 0 ? JSON.stringify(headers) : null;
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string') {
      headers[key] = headerValue;
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function isUsablePresetApiKey(apiKey: string): boolean {
  const normalized = apiKey.trim();
  return Boolean(normalized && !normalized.startsWith('REPLACE_WITH_'));
}

async function readApiKeyFromAuthProfiles(providerKey: string): Promise<string | null> {
  const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  let store: AuthProfilesStore;
  try {
    store = JSON.parse(await readFile(authPath, 'utf-8')) as AuthProfilesStore;
  } catch {
    return null;
  }

  const profileId = store.lastGood?.[providerKey] || `${providerKey}:default`;
  const profile = store.profiles?.[profileId];
  if (profile?.type === 'api_key' && typeof profile.key === 'string' && profile.key.trim()) {
    return profile.key.trim();
  }
  return null;
}

async function readBundledDefaultAiProviderPreset(): Promise<ResolvedDefaultAiProviderPreset | null> {
  const presetPath = join(getResourcesDir(), 'config', 'default-ai-provider.json');
  let raw: string;
  try {
    raw = await readFile(presetPath, 'utf-8');
  } catch {
    return null;
  }

  let preset: DefaultAiProviderPreset;
  try {
    preset = JSON.parse(raw) as DefaultAiProviderPreset;
  } catch {
    return null;
  }

  if (preset.enabled === false) {
    return null;
  }

  const provider = typeof preset.provider === 'string' ? preset.provider.trim() : '';
  const model = typeof preset.model === 'string' ? preset.model.trim() : '';
  const baseUrl = typeof preset.baseUrl === 'string' ? preset.baseUrl.trim() : '';
  const api = parseApi(preset.api);
  const apiKey = typeof preset.apiKey === 'string' ? preset.apiKey.trim() : '';
  const apiKeyEnv = typeof preset.apiKeyEnv === 'string' && preset.apiKeyEnv.trim()
    ? preset.apiKeyEnv.trim()
    : 'CCLAWD_DEFAULT_AI_API_KEY';

  if (!provider || !model || !baseUrl || !api || !isUsablePresetApiKey(apiKey)) {
    return null;
  }

  return {
    provider,
    model,
    baseUrl,
    api,
    apiKey,
    apiKeyEnv,
    headers: normalizeHeaders(preset.headers),
  };
}

async function writePresetToEnv(
  entries: OpenClawEnvEntry[],
  preset: ResolvedDefaultAiProviderPreset,
): Promise<void> {
  let nextEntries = entries;
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_PROVIDER', preset.provider);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_MODEL', preset.model);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_BASE_URL', preset.baseUrl);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API', preset.api);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API_KEY', preset.apiKey);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API_KEY_ENV', preset.apiKeyEnv);

  const headers = resolveHeaders(preset.headers);
  if (headers) {
    nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_HEADERS', headers);
  } else {
    nextEntries = removeEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_HEADERS');
  }

  await writeOpenClawEnv(nextEntries);
}

export async function ensureLocalDefaultProviderEnvFromOpenClaw(): Promise<DefaultProviderEnvBootstrapResult> {
  const current = await readOpenClawEnv();
  if (hasDefaultAiEnv(current.entries)) {
    return { status: 'already-configured' };
  }

  const { providers, defaultModel } = await getOpenClawProvidersConfig();
  const modelRef = parseModelRef(defaultModel);
  if (!modelRef) {
    const preset = await readBundledDefaultAiProviderPreset();
    if (!preset) {
      return { status: 'skipped', reason: 'missing-default-model' };
    }
    await writePresetToEnv(current.entries, preset);
    return {
      status: 'configured',
      source: 'preset',
      provider: preset.provider,
      model: preset.model,
    };
  }

  if (modelRef.providerKey === 'cclawd-default') {
    const preset = await readBundledDefaultAiProviderPreset();
    if (!preset) {
      return { status: 'skipped', reason: 'default-provider-is-managed' };
    }
    await writePresetToEnv(current.entries, preset);
    return {
      status: 'configured',
      source: 'preset',
      provider: preset.provider,
      model: preset.model,
    };
  }

  const providerEntry = providers[modelRef.providerKey];
  if (!providerEntry || typeof providerEntry !== 'object') {
    const preset = await readBundledDefaultAiProviderPreset();
    if (!preset) {
      return { status: 'skipped', reason: 'missing-provider-entry' };
    }
    await writePresetToEnv(current.entries, preset);
    return {
      status: 'configured',
      source: 'preset',
      provider: preset.provider,
      model: preset.model,
    };
  }

  const localProviderType = resolveLocalProviderType(modelRef.providerKey);
  const definition = getProviderDefinition(localProviderType);
  const baseUrl = typeof providerEntry.baseUrl === 'string'
    ? providerEntry.baseUrl.trim()
    : definition?.providerConfig?.baseUrl;
  const api = parseApi(providerEntry.api) || definition?.providerConfig?.api;
  const apiKey = await readApiKeyFromAuthProfiles(modelRef.providerKey);

  if (!baseUrl || !api || !apiKey) {
    const preset = await readBundledDefaultAiProviderPreset();
    if (!preset) {
      return { status: 'skipped', reason: 'incomplete-provider-config' };
    }
    await writePresetToEnv(current.entries, preset);
    return {
      status: 'configured',
      source: 'preset',
      provider: preset.provider,
      model: preset.model,
    };
  }

  let nextEntries = current.entries;
  for (const key of DEFAULT_AI_ENV_KEYS) {
    if (key !== 'CCLAWD_DEFAULT_AI_HEADERS') {
      continue;
    }
    nextEntries = removeEnvEntry(nextEntries, key);
  }

  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_PROVIDER', localProviderType);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_MODEL', modelRef.model);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_BASE_URL', baseUrl);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API', api);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API_KEY', apiKey);
  nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_API_KEY_ENV', 'CCLAWD_DEFAULT_AI_API_KEY');

  const headers = resolveHeaders(providerEntry.headers);
  if (headers) {
    nextEntries = upsertEnvEntry(nextEntries, 'CCLAWD_DEFAULT_AI_HEADERS', headers);
  }

  await writeOpenClawEnv(nextEntries);
  return {
    status: 'configured',
    source: 'openclaw',
    provider: localProviderType,
    model: modelRef.model,
  };
}
