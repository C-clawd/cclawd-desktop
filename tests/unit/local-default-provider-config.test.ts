import { afterEach, describe, expect, it, vi } from 'vitest';

const readOpenClawEnvMock = vi.fn();
const ORIGINAL_ENV = { ...process.env };

vi.mock('@electron/utils/openclaw-env', () => ({
  readOpenClawEnv: readOpenClawEnvMock,
}));

async function loadModule() {
  vi.resetModules();
  return import('@electron/services/providers/local-default-provider-config');
}

function resetDefaultProviderEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('CCLAWD_DEFAULT_AI_')) {
      delete process.env[key];
    }
  }
}

describe('local default provider config', () => {
  afterEach(() => {
    resetDefaultProviderEnv();
    Object.assign(process.env, ORIGINAL_ENV);
    vi.clearAllMocks();
  });

  it('returns null when required env vars are missing', async () => {
    resetDefaultProviderEnv();
    process.env.CCLAWD_DEFAULT_AI_PROVIDER = 'moonshot';
    readOpenClawEnvMock.mockResolvedValue({ path: 'C:\\Users\\asta1\\.openclaw\\.env', entries: [] });

    const { resolveLocalDefaultProviderConfig } = await loadModule();

    await expect(resolveLocalDefaultProviderConfig()).resolves.toBeNull();
  });

  it('uses provider registry defaults when optional env vars are omitted', async () => {
    resetDefaultProviderEnv();
    process.env.CCLAWD_DEFAULT_AI_PROVIDER = 'moonshot';
    process.env.CCLAWD_DEFAULT_AI_API_KEY = 'sk-default';
    readOpenClawEnvMock.mockResolvedValue({ path: 'C:\\Users\\asta1\\.openclaw\\.env', entries: [] });

    const { resolveLocalDefaultProviderConfig } = await loadModule();

    await expect(resolveLocalDefaultProviderConfig()).resolves.toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
      apiKey: 'sk-default',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      headers: undefined,
    });
  });

  it('allows explicit OpenAI-compatible defaults', async () => {
    resetDefaultProviderEnv();
    process.env.CCLAWD_DEFAULT_AI_PROVIDER = 'custom';
    process.env.CCLAWD_DEFAULT_AI_API_KEY = 'sk-custom';
    process.env.CCLAWD_DEFAULT_AI_MODEL = 'vendor/model';
    process.env.CCLAWD_DEFAULT_AI_BASE_URL = 'https://example.test/v1';
    process.env.CCLAWD_DEFAULT_AI_API = 'openai-completions';
    process.env.CCLAWD_DEFAULT_AI_API_KEY_ENV = 'CCLAWD_DEFAULT_AI_API_KEY';
    process.env.CCLAWD_DEFAULT_AI_HEADERS = '{"X-Title":"Cclawd"}';
    readOpenClawEnvMock.mockResolvedValue({ path: 'C:\\Users\\asta1\\.openclaw\\.env', entries: [] });

    const { resolveLocalDefaultProviderConfig } = await loadModule();

    await expect(resolveLocalDefaultProviderConfig()).resolves.toEqual({
      provider: 'custom',
      model: 'vendor/model',
      baseUrl: 'https://example.test/v1',
      api: 'openai-completions',
      apiKey: 'sk-custom',
      apiKeyEnv: 'CCLAWD_DEFAULT_AI_API_KEY',
      headers: { 'X-Title': 'Cclawd' },
    });
  });

  it('reads default provider settings from the OpenClaw env file', async () => {
    resetDefaultProviderEnv();
    readOpenClawEnvMock.mockResolvedValue({
      path: 'C:\\Users\\asta1\\.openclaw\\.env',
      entries: [
        { key: 'CCLAWD_DEFAULT_AI_PROVIDER', value: 'moonshot' },
        { key: 'CCLAWD_DEFAULT_AI_API_KEY', value: 'sk-from-file' },
      ],
    });

    const { resolveLocalDefaultProviderConfig } = await loadModule();

    await expect(resolveLocalDefaultProviderConfig()).resolves.toEqual({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
      apiKey: 'sk-from-file',
      apiKeyEnv: 'MOONSHOT_API_KEY',
      headers: undefined,
    });
  });

  it('lets process env override individual OpenClaw env file values', async () => {
    resetDefaultProviderEnv();
    process.env.CCLAWD_DEFAULT_AI_API_KEY = 'sk-from-process';
    readOpenClawEnvMock.mockResolvedValue({
      path: 'C:\\Users\\asta1\\.openclaw\\.env',
      entries: [
        { key: 'CCLAWD_DEFAULT_AI_PROVIDER', value: 'moonshot' },
        { key: 'CCLAWD_DEFAULT_AI_API_KEY', value: 'sk-from-file' },
      ],
    });

    const { resolveLocalDefaultProviderConfig } = await loadModule();

    await expect(resolveLocalDefaultProviderConfig()).resolves.toMatchObject({
      provider: 'moonshot',
      apiKey: 'sk-from-process',
    });
  });
});
