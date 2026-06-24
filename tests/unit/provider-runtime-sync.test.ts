import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';
import type { ProviderConfig } from '@electron/utils/secure-storage';

const mocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  listProviderAccounts: vi.fn(),
  getProviderSecret: vi.fn(),
  getAllProviders: vi.fn(),
  getApiKey: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderDefaultModel: vi.fn(),
  removeProviderFromOpenClaw: vi.fn(),
  saveOAuthTokenToOpenClaw: vi.fn(),
  saveProviderKeyToOpenClaw: vi.fn(),
  setOpenClawDefaultModel: vi.fn(),
  setOpenClawDefaultModelWithOverride: vi.fn(),
  setOpenClawDefaultModelReference: vi.fn(),
  syncProviderConfigToOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  resolveLocalDefaultProviderConfig: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
  listProviderAccounts: mocks.listProviderAccounts,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: mocks.getProviderSecret,
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getAllProviders: mocks.getAllProviders,
  getApiKey: mocks.getApiKey,
  getDefaultProvider: mocks.getDefaultProvider,
  getProvider: mocks.getProvider,
}));

vi.mock('@electron/utils/provider-registry', () => ({
  getProviderConfig: mocks.getProviderConfig,
  getProviderDefaultModel: mocks.getProviderDefaultModel,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  removeProviderFromOpenClaw: mocks.removeProviderFromOpenClaw,
  saveOAuthTokenToOpenClaw: mocks.saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw: mocks.saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel: mocks.setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride: mocks.setOpenClawDefaultModelWithOverride,
  setOpenClawDefaultModelReference: mocks.setOpenClawDefaultModelReference,
  syncProviderConfigToOpenClaw: mocks.syncProviderConfigToOpenClaw,
  updateAgentModelProvider: mocks.updateAgentModelProvider,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@electron/services/providers/local-default-provider-config', () => ({
  resolveLocalDefaultProviderConfig: mocks.resolveLocalDefaultProviderConfig,
}));

import {
  syncDefaultProviderToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
} from '@electron/services/providers/provider-runtime-sync';

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'moonshot',
    name: 'Moonshot',
    type: 'moonshot',
    model: 'kimi-k2.5',
    enabled: true,
    createdAt: '2026-03-14T00:00:00.000Z',
    updatedAt: '2026-03-14T00:00:00.000Z',
    ...overrides,
  };
}

function createGateway(state: 'running' | 'stopped' = 'running'): Pick<GatewayManager, 'debouncedReload' | 'debouncedRestart' | 'getStatus'> {
  return {
    debouncedReload: vi.fn(),
    debouncedRestart: vi.fn(),
    getStatus: vi.fn(() => ({ state } as ReturnType<GatewayManager['getStatus']>)),
  };
}

describe('provider-runtime-sync refresh strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.getProviderSecret.mockResolvedValue(undefined);
    mocks.getAllProviders.mockResolvedValue([]);
    mocks.getApiKey.mockResolvedValue('sk-test');
    mocks.getDefaultProvider.mockResolvedValue('moonshot');
    mocks.getProvider.mockResolvedValue(createProvider());
    mocks.getProviderDefaultModel.mockReturnValue('kimi-k2.5');
    mocks.getProviderConfig.mockReturnValue({
      api: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
    });
    mocks.syncProviderConfigToOpenClaw.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModel.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModelWithOverride.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModelReference.mockResolvedValue(true);
    mocks.saveProviderKeyToOpenClaw.mockResolvedValue(undefined);
    mocks.removeProviderFromOpenClaw.mockResolvedValue(undefined);
    mocks.updateAgentModelProvider.mockResolvedValue(undefined);
    mocks.resolveLocalDefaultProviderConfig.mockResolvedValue(null);
  });

  it('uses debouncedReload after saving provider config', async () => {
    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(createProvider(), undefined, gateway as GatewayManager);

    expect(gateway.debouncedReload).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('uses debouncedRestart after deleting provider config', async () => {
    const gateway = createGateway('running');
    await syncDeletedProviderToRuntime(createProvider(), 'moonshot', gateway as GatewayManager);

    expect(gateway.debouncedRestart).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('uses debouncedReload after switching default provider when gateway is running', async () => {
    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(gateway.debouncedReload).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('skips refresh after switching default provider when gateway is stopped', async () => {
    const gateway = createGateway('stopped');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('writes the local default provider config when switching to Cclawd Default', async () => {
    mocks.getProvider.mockResolvedValue(createProvider({
      id: 'cclawd-default',
      name: 'Cclawd Default',
      type: 'cclawd-default' as ProviderConfig['type'],
      model: 'cclawd-auto',
    }));
    mocks.resolveLocalDefaultProviderConfig.mockResolvedValue({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      baseUrl: 'https://api.moonshot.cn/v1',
      api: 'openai-completions',
      apiKey: 'sk-default',
      apiKeyEnv: 'CCLAWD_DEFAULT_AI_API_KEY',
    });
    const gateway = createGateway('running');

    await syncDefaultProviderToRuntime('cclawd-default', gateway as GatewayManager);

    expect(mocks.saveProviderKeyToOpenClaw).toHaveBeenCalledWith('cclawd-default', 'sk-default');
    expect(mocks.setOpenClawDefaultModelWithOverride).toHaveBeenCalledWith(
      'cclawd-default',
      'cclawd-default/kimi-k2.5',
      {
        baseUrl: 'https://api.moonshot.cn/v1',
        api: 'openai-completions',
        apiKeyEnv: 'CCLAWD_DEFAULT_AI_API_KEY',
        headers: undefined,
      },
    );
    expect(mocks.setOpenClawDefaultModelReference).not.toHaveBeenCalled();
    expect(mocks.setOpenClawDefaultModel).not.toHaveBeenCalled();
    expect(mocks.syncProviderConfigToOpenClaw).not.toHaveBeenCalled();
    expect(gateway.debouncedReload).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('falls back to the managed model reference when Cclawd Default has no local config', async () => {
    mocks.getProvider.mockResolvedValue(createProvider({
      id: 'cclawd-default',
      name: 'Cclawd Default',
      type: 'cclawd-default' as ProviderConfig['type'],
      model: 'cclawd-auto',
    }));
    const gateway = createGateway('running');

    await syncDefaultProviderToRuntime('cclawd-default', gateway as GatewayManager);

    expect(mocks.setOpenClawDefaultModelReference).toHaveBeenCalledWith('cclawd-default/cclawd-auto');
    expect(mocks.setOpenClawDefaultModelWithOverride).not.toHaveBeenCalled();
    expect(mocks.saveProviderKeyToOpenClaw).not.toHaveBeenCalled();
    expect(gateway.debouncedReload).toHaveBeenCalledTimes(1);
  });
});
