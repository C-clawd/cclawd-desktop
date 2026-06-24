import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  homedir: vi.fn(() => 'C:\\Users\\asta1'),
  getResourcesDir: vi.fn(() => 'C:\\Program Files\\Cclawd\\resources'),
  readOpenClawEnv: vi.fn(),
  writeOpenClawEnv: vi.fn(),
  getOpenClawProvidersConfig: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    default: {
      ...actual,
      readFile: mocks.readFile,
    },
    readFile: mocks.readFile,
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: {
      ...actual,
      homedir: mocks.homedir,
    },
    homedir: mocks.homedir,
  };
});

vi.mock('@electron/utils/openclaw-env', () => ({
  readOpenClawEnv: mocks.readOpenClawEnv,
  writeOpenClawEnv: mocks.writeOpenClawEnv,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  getOpenClawProvidersConfig: mocks.getOpenClawProvidersConfig,
}));

vi.mock('@electron/utils/paths', () => ({
  getResourcesDir: mocks.getResourcesDir,
}));

async function loadModule() {
  vi.resetModules();
  return import('@electron/services/providers/local-default-provider-env-bootstrap');
}

describe('local default provider env bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.homedir.mockReturnValue('C:\\Users\\asta1');
    mocks.getResourcesDir.mockReturnValue('C:\\Program Files\\Cclawd\\resources');
    mocks.readOpenClawEnv.mockResolvedValue({
      path: 'C:\\Users\\asta1\\.openclaw\\.env',
      entries: [],
    });
    mocks.writeOpenClawEnv.mockResolvedValue({
      path: 'C:\\Users\\asta1\\.openclaw\\.env',
      entries: [],
    });
    mocks.getOpenClawProvidersConfig.mockResolvedValue({
      providers: {},
      defaultModel: undefined,
    });
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      profiles: {},
      lastGood: {},
    }));
  });

  it('writes CCLAWD_DEFAULT_AI entries from the current OpenClaw default provider', async () => {
    mocks.getOpenClawProvidersConfig.mockResolvedValue({
      providers: {
        'custom-customd4': {
          baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
          api: 'openai-completions',
          headers: {
            'X-Title': 'Cclawd',
          },
          models: [
            { id: 'glm-5', name: 'glm-5' },
          ],
        },
      },
      defaultModel: 'custom-customd4/glm-5',
    });
    mocks.readFile.mockResolvedValue(JSON.stringify({
      version: 1,
      profiles: {
        'custom-customd4:default': {
          type: 'api_key',
          provider: 'custom-customd4',
          key: 'sk-custom',
        },
      },
      lastGood: {
        'custom-customd4': 'custom-customd4:default',
      },
    }));

    const { ensureLocalDefaultProviderEnvFromOpenClaw } = await loadModule();

    await expect(ensureLocalDefaultProviderEnvFromOpenClaw()).resolves.toEqual({
      status: 'configured',
      source: 'openclaw',
      provider: 'custom',
      model: 'glm-5',
    });
    expect(mocks.writeOpenClawEnv).toHaveBeenCalledWith([
      { key: 'CCLAWD_DEFAULT_AI_PROVIDER', value: 'custom' },
      { key: 'CCLAWD_DEFAULT_AI_MODEL', value: 'glm-5' },
      { key: 'CCLAWD_DEFAULT_AI_BASE_URL', value: 'https://api.lkeap.cloud.tencent.com/coding/v3' },
      { key: 'CCLAWD_DEFAULT_AI_API', value: 'openai-completions' },
      { key: 'CCLAWD_DEFAULT_AI_API_KEY', value: 'sk-custom' },
      { key: 'CCLAWD_DEFAULT_AI_API_KEY_ENV', value: 'CCLAWD_DEFAULT_AI_API_KEY' },
      { key: 'CCLAWD_DEFAULT_AI_HEADERS', value: '{"X-Title":"Cclawd"}' },
    ]);
  });

  it('writes bundled preset when no OpenClaw provider is configured', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      enabled: true,
      provider: 'custom',
      model: 'glm-5',
      baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
      api: 'openai-completions',
      apiKey: 'sk-bundled',
      apiKeyEnv: 'CCLAWD_DEFAULT_AI_API_KEY',
    }));

    const { ensureLocalDefaultProviderEnvFromOpenClaw } = await loadModule();

    await expect(ensureLocalDefaultProviderEnvFromOpenClaw()).resolves.toEqual({
      status: 'configured',
      source: 'preset',
      provider: 'custom',
      model: 'glm-5',
    });
    expect(mocks.writeOpenClawEnv).toHaveBeenCalledWith([
      { key: 'CCLAWD_DEFAULT_AI_PROVIDER', value: 'custom' },
      { key: 'CCLAWD_DEFAULT_AI_MODEL', value: 'glm-5' },
      { key: 'CCLAWD_DEFAULT_AI_BASE_URL', value: 'https://api.lkeap.cloud.tencent.com/coding/v3' },
      { key: 'CCLAWD_DEFAULT_AI_API', value: 'openai-completions' },
      { key: 'CCLAWD_DEFAULT_AI_API_KEY', value: 'sk-bundled' },
      { key: 'CCLAWD_DEFAULT_AI_API_KEY_ENV', value: 'CCLAWD_DEFAULT_AI_API_KEY' },
    ]);
  });

  it('skips bundled preset when the preset API key is a placeholder', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({
      enabled: true,
      provider: 'custom',
      model: 'glm-5',
      baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3',
      api: 'openai-completions',
      apiKey: 'REPLACE_WITH_DEFAULT_PROVIDER_API_KEY',
    }));

    const { ensureLocalDefaultProviderEnvFromOpenClaw } = await loadModule();

    await expect(ensureLocalDefaultProviderEnvFromOpenClaw()).resolves.toEqual({
      status: 'skipped',
      reason: 'missing-default-model',
    });
    expect(mocks.writeOpenClawEnv).not.toHaveBeenCalled();
  });

  it('does not overwrite existing default AI env configuration', async () => {
    mocks.readOpenClawEnv.mockResolvedValue({
      path: 'C:\\Users\\asta1\\.openclaw\\.env',
      entries: [
        { key: 'CCLAWD_DEFAULT_AI_PROVIDER', value: 'moonshot' },
        { key: 'CCLAWD_DEFAULT_AI_API_KEY', value: 'sk-existing' },
      ],
    });

    const { ensureLocalDefaultProviderEnvFromOpenClaw } = await loadModule();

    await expect(ensureLocalDefaultProviderEnvFromOpenClaw()).resolves.toEqual({
      status: 'already-configured',
    });
    expect(mocks.writeOpenClawEnv).not.toHaveBeenCalled();
  });

  it('skips when the current provider key has no API key profile', async () => {
    mocks.getOpenClawProvidersConfig.mockResolvedValue({
      providers: {
        moonshot: {
          baseUrl: 'https://api.moonshot.cn/v1',
          api: 'openai-completions',
        },
      },
      defaultModel: 'moonshot/kimi-k2.5',
    });

    const { ensureLocalDefaultProviderEnvFromOpenClaw } = await loadModule();

    await expect(ensureLocalDefaultProviderEnvFromOpenClaw()).resolves.toEqual({
      status: 'skipped',
      reason: 'incomplete-provider-config',
    });
    expect(mocks.writeOpenClawEnv).not.toHaveBeenCalled();
  });
});
