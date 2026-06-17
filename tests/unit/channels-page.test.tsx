import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Channels } from '@/pages/Channels/index';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();

const { gatewayState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789 },
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('Channels page status refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayState.status = { state: 'running', port: 18789 };
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/channels/accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'feishu',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'Primary Account',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });
  });

  it('refetches channel accounts when gateway channel-status events arrive', async () => {
    let channelStatusHandler: (() => void) | undefined;
    subscribeHostEventMock.mockImplementation((eventName: string, handler: () => void) => {
      if (eventName === 'gateway:channel-status') {
        channelStatusHandler = handler;
      }
      return vi.fn();
    });

    render(<Channels />);

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts');
    });
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));
    expect(screen.queryByText('account.bindAgentLabel')).not.toBeInTheDocument();

    await act(async () => {
      channelStatusHandler?.();
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts');
      expect(channelFetchCalls).toHaveLength(2);
    });
  });

  it('refetches when the gateway transitions to running after mount', async () => {
    gatewayState.status = { state: 'starting', port: 18789 };

    const { rerender } = render(<Channels />);

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/accounts');
    });

    gatewayState.status = { state: 'running', port: 18789 };
    await act(async () => {
      rerender(<Channels />);
    });

    await waitFor(() => {
      const channelFetchCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/channels/accounts');
      expect(channelFetchCalls).toHaveLength(2);
    });
  });

  it('treats WeChat accounts as plugin-managed QR accounts', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/channels/accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'wechat',
              defaultAccountId: 'wx-bot-im-bot',
              status: 'connected',
              accounts: [
                {
                  accountId: 'wx-bot-im-bot',
                  name: 'WeChat ClawBot',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      if (path === '/api/channels/wechat/cancel') {
        return { success: true };
      }

      if (path === '/api/channels/wechat/start') {
        return { success: true };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('个人微信')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: 'account.add' })).not.toBeInTheDocument();
    expect(screen.getByText('account.singleAccountHint')).toBeInTheDocument();
    expect(screen.queryByLabelText('account.customIdLabel')).not.toBeInTheDocument();
  });

  it('auto-generates a QR code when linking WeChat for the first time', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/channels/accounts') {
        return {
          success: true,
          channels: [],
        };
      }

      if (path === '/api/channels/wechat/cancel') {
        return { success: true };
      }

      if (path === '/api/channels/wechat/start') {
        return { success: true };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('supportedChannels')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /Telegram/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discord/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /个人微信/ }));

    await waitFor(() => {
      expect(screen.getByText('dialog.configureTitle')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/channels/wechat/start', {
        method: 'POST',
        body: JSON.stringify({}),
      });
    });

    expect(screen.queryByText('dialog.generateQRCode')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('account.customIdLabel')).not.toBeInTheDocument();
  });

  it('hides unsupported overseas channels from the production channel UI', async () => {
    subscribeHostEventMock.mockImplementation(() => vi.fn());
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/channels/accounts') {
        return {
          success: true,
          channels: [
            {
              channelType: 'telegram',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'Telegram Bot',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
            {
              channelType: 'dingtalk',
              defaultAccountId: 'default',
              status: 'connected',
              accounts: [
                {
                  accountId: 'default',
                  name: 'DingTalk Bot',
                  configured: true,
                  status: 'connected',
                  isDefault: true,
                },
              ],
            },
          ],
        };
      }

      throw new Error(`Unexpected host API path: ${path}`);
    });

    render(<Channels />);

    await waitFor(() => {
      expect(screen.getByText('钉钉')).toBeInTheDocument();
    });

    expect(screen.queryByText('Telegram')).not.toBeInTheDocument();
    expect(screen.queryByText('Telegram Bot')).not.toBeInTheDocument();
  });
});
