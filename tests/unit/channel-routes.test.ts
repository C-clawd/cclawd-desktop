import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const listConfiguredChannelsMock = vi.fn();
const listConfiguredChannelAccountsMock = vi.fn();
const readOpenClawConfigMock = vi.fn();
const listAgentsSnapshotMock = vi.fn();
const assignChannelAccountToAgentMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const getChannelFormValuesMock = vi.fn();
const saveChannelConfigMock = vi.fn();
const whatsAppStartMock = vi.fn();

vi.mock('@electron/utils/channel-config', () => ({
  cleanupDanglingWeChatPluginState: vi.fn(),
  deleteChannelAccountConfig: vi.fn(),
  deleteChannelConfig: vi.fn(),
  getChannelFormValues: (...args: unknown[]) => getChannelFormValuesMock(...args),
  listConfiguredChannelAccounts: (...args: unknown[]) => listConfiguredChannelAccountsMock(...args),
  listConfiguredChannels: (...args: unknown[]) => listConfiguredChannelsMock(...args),
  readOpenClawConfig: (...args: unknown[]) => readOpenClawConfigMock(...args),
  saveChannelConfig: (...args: unknown[]) => saveChannelConfigMock(...args),
  setChannelDefaultAccount: vi.fn(),
  setChannelEnabled: vi.fn(),
  validateChannelConfig: vi.fn(),
  validateChannelCredentials: vi.fn(),
}));

vi.mock('@electron/utils/agent-config', () => ({
  assignChannelAccountToAgent: (...args: unknown[]) => assignChannelAccountToAgentMock(...args),
  clearAllBindingsForChannel: vi.fn(),
  clearChannelBinding: vi.fn(),
  listAgentsSnapshot: (...args: unknown[]) => listAgentsSnapshotMock(...args),
}));

vi.mock('@electron/utils/plugin-install', () => ({
  ensureDingTalkPluginInstalled: vi.fn(),
  ensureFeishuPluginInstalled: vi.fn(),
  ensureQQBotPluginInstalled: vi.fn(),
  ensureWeChatPluginInstalled: vi.fn(),
  ensureWeComPluginInstalled: vi.fn(),
}));

vi.mock('@electron/utils/wechat-login', () => ({
  cancelWeChatLoginSession: vi.fn(),
  saveWeChatAccountState: vi.fn(),
  startWeChatLoginSession: vi.fn(),
  waitForWeChatLoginSession: vi.fn(),
}));

vi.mock('@electron/utils/whatsapp-login', () => ({
  whatsAppLoginManager: {
    start: (...args: unknown[]) => whatsAppStartMock(...args),
    stop: vi.fn(),
  },
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('handleChannelRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [{ id: 'main', name: 'Main Agent' }],
      channelAccountOwners: {},
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {},
    });
    listConfiguredChannelsMock.mockResolvedValue([]);
    listConfiguredChannelAccountsMock.mockResolvedValue({});
    getChannelFormValuesMock.mockResolvedValue(undefined);
    parseJsonBodyMock.mockResolvedValue({});
  });

  it('reports healthy running multi-account channels as connected', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['feishu']);
    listConfiguredChannelAccountsMock.mockResolvedValue({
      feishu: {
        defaultAccountId: 'default',
        accountIds: ['default', 'feishu-2412524e'],
      },
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          defaultAccount: 'default',
        },
      },
    });
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [],
      channelAccountOwners: {
        'feishu:default': 'main',
        'feishu:feishu-2412524e': 'code',
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      channels: {
        feishu: {
          configured: true,
        },
      },
      channelAccounts: {
        feishu: [
          {
            accountId: 'default',
            configured: true,
            connected: true,
            running: true,
            linked: false,
          },
          {
            accountId: 'feishu-2412524e',
            configured: true,
            connected: true,
            running: true,
            linked: false,
          },
        ],
      },
      channelDefaultAccountId: {
        feishu: 'default',
      },
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    const handled = await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/accounts'),
      {
        gatewayManager: {
          rpc,
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpc).toHaveBeenCalledWith('channels.status', { probe: true });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        channels: [
          expect.objectContaining({
            channelType: 'feishu',
            status: 'connected',
            accounts: expect.arrayContaining([
              expect.objectContaining({ accountId: 'default', status: 'connected' }),
              expect.objectContaining({ accountId: 'feishu-2412524e', status: 'connected' }),
            ]),
          }),
        ],
      }),
    );
  });

  it('keeps channel connected when one account is healthy and another errors', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['telegram']);
    listConfiguredChannelAccountsMock.mockResolvedValue({
      telegram: {
        defaultAccountId: 'default',
        accountIds: ['default', 'telegram-b'],
      },
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        telegram: {
          defaultAccount: 'default',
        },
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      channels: {
        telegram: {
          configured: true,
        },
      },
      channelAccounts: {
        telegram: [
          {
            accountId: 'default',
            configured: true,
            connected: true,
            running: true,
            linked: false,
          },
          {
            accountId: 'telegram-b',
            configured: true,
            connected: false,
            running: false,
            linked: false,
            lastError: 'secondary bot failed',
          },
        ],
      },
      channelDefaultAccountId: {
        telegram: 'default',
      },
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/accounts'),
      {
        gatewayManager: {
          rpc,
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        channels: [
          expect.objectContaining({
            channelType: 'telegram',
            status: 'connected',
            accounts: expect.arrayContaining([
              expect.objectContaining({ accountId: 'default', status: 'connected' }),
              expect.objectContaining({ accountId: 'telegram-b', status: 'error' }),
            ]),
          }),
        ],
      }),
    );
  });

  it('auto-binds existing channel accounts to main when owner is missing', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['feishu']);
    listConfiguredChannelAccountsMock.mockResolvedValue({
      feishu: {
        defaultAccountId: 'default',
        accountIds: ['default', 'feishu-2412524e'],
      },
    });
    readOpenClawConfigMock.mockResolvedValue({
      channels: {
        feishu: {
          defaultAccount: 'default',
        },
      },
    });
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [{ id: 'main', name: 'Main Agent' }],
      channelAccountOwners: {
        'feishu:feishu-2412524e': 'old-agent',
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      channels: {
        feishu: {
          configured: true,
        },
      },
      channelAccounts: {
        feishu: [
          {
            accountId: 'default',
            configured: true,
            connected: true,
            running: true,
          },
          {
            accountId: 'feishu-2412524e',
            configured: true,
            connected: true,
            running: true,
          },
        ],
      },
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/accounts'),
      {
        gatewayManager: {
          rpc,
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(assignChannelAccountToAgentMock).toHaveBeenCalledWith('main', 'feishu', 'default');
    expect(assignChannelAccountToAgentMock).toHaveBeenCalledWith('main', 'feishu', 'feishu-2412524e');
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        channels: [
          expect.objectContaining({
            accounts: expect.arrayContaining([
              expect.objectContaining({ accountId: 'default', agentId: 'main' }),
              expect.objectContaining({ accountId: 'feishu-2412524e', agentId: 'main' }),
            ]),
          }),
        ],
      }),
    );
  });

  it('forces manual binding API calls to main agent', async () => {
    parseJsonBodyMock.mockResolvedValue({
      channelType: 'telegram',
      accountId: 'telegram-2412524e',
      agentId: 'ignored-agent',
    });

    const debouncedReload = vi.fn();
    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/binding'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload,
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(assignChannelAccountToAgentMock).toHaveBeenCalledWith('main', 'telegram', 'telegram-2412524e');
    expect(debouncedReload).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('rejects saving a second account for an already configured channel', async () => {
    listConfiguredChannelAccountsMock.mockResolvedValue({
      feishu: {
        defaultAccountId: 'default',
        accountIds: ['default'],
      },
    });
    parseJsonBodyMock.mockResolvedValue({
      channelType: 'feishu',
      accountId: 'feishu-secondary',
      config: { appId: 'app-2' },
    });

    const { ensureFeishuPluginInstalled } = await import('@electron/utils/plugin-install');
    vi.mocked(ensureFeishuPluginInstalled).mockReturnValue({ installed: true });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/config'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(saveChannelConfigMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('only one account per channel'),
      }),
    );
  });

  it('allows saving the existing account for a configured channel', async () => {
    listConfiguredChannelAccountsMock.mockResolvedValue({
      feishu: {
        defaultAccountId: 'default',
        accountIds: ['default'],
      },
    });
    parseJsonBodyMock.mockResolvedValue({
      channelType: 'feishu',
      accountId: 'default',
      config: { appId: 'app-1' },
    });

    const { ensureFeishuPluginInstalled } = await import('@electron/utils/plugin-install');
    vi.mocked(ensureFeishuPluginInstalled).mockReturnValue({ installed: true });

    const debouncedRestart = vi.fn();
    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/config'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart,
        },
      } as never,
    );

    expect(saveChannelConfigMock).toHaveBeenCalledWith('feishu', { appId: 'app-1' }, 'default');
    expect(assignChannelAccountToAgentMock).toHaveBeenCalledWith('main', 'feishu', 'default');
    expect(debouncedRestart).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('rejects starting a plugin QR flow for a second channel account', async () => {
    listConfiguredChannelsMock.mockResolvedValue(['whatsapp']);
    parseJsonBodyMock.mockResolvedValue({
      accountId: 'whatsapp-secondary',
    });

    const { handleChannelRoutes } = await import('@electron/api/routes/channels');
    await handleChannelRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/channels/whatsapp/start'),
      {
        gatewayManager: {
          rpc: vi.fn(),
          getStatus: () => ({ state: 'running' }),
          debouncedReload: vi.fn(),
          debouncedRestart: vi.fn(),
        },
      } as never,
    );

    expect(whatsAppStartMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('only one account per channel'),
      }),
    );
  });
});
