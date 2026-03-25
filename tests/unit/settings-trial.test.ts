import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const getAllSettingsMock = vi.fn();
const resetSettingsMock = vi.fn();
const applyProxySettingsMock = vi.fn();
const syncProxyConfigToOpenClawMock = vi.fn();
const syncLaunchAtStartupSettingFromStoreMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
  setSetting: (...args: unknown[]) => setSettingMock(...args),
  getAllSettings: (...args: unknown[]) => getAllSettingsMock(...args),
  resetSettings: (...args: unknown[]) => resetSettingsMock(...args),
}));

vi.mock('@electron/main/proxy', () => ({
  applyProxySettings: (...args: unknown[]) => applyProxySettingsMock(...args),
}));

vi.mock('@electron/utils/openclaw-proxy', () => ({
  syncProxyConfigToOpenClaw: (...args: unknown[]) => syncProxyConfigToOpenClawMock(...args),
}));

vi.mock('@electron/main/launch-at-startup', () => ({
  syncLaunchAtStartupSettingFromStore: (...args: unknown[]) => syncLaunchAtStartupSettingFromStoreMock(...args),
}));

describe('settings routes trial protections', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAllSettingsMock.mockResolvedValue({
      proxyEnabled: false,
      launchAtStartup: false,
      trialStartAt: 123,
    });
  });

  it('rejects direct trialStartAt writes', async () => {
    const { handleSettingsRoutes } = await import('@electron/api/routes/settings');

    const handled = await handleSettingsRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/settings/trialStartAt'),
      { gatewayManager: { getStatus: () => ({ state: 'stopped' }) } } as never,
    );

    expect(handled).toBe(true);
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 403, {
      success: false,
      code: 'PERMISSION',
      error: 'trialStartAt is read-only',
    });
  });

  it('ignores trialStartAt in bulk settings updates', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      trialStartAt: 0,
      telemetryEnabled: false,
    });

    const { handleSettingsRoutes } = await import('@electron/api/routes/settings');

    await handleSettingsRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/settings'),
      { gatewayManager: { getStatus: () => ({ state: 'stopped' }) } } as never,
    );

    expect(setSettingMock).toHaveBeenCalledTimes(1);
    expect(setSettingMock).toHaveBeenCalledWith('telemetryEnabled', false);
  });

  it('preserves trialStartAt across settings reset', async () => {
    getSettingMock.mockResolvedValueOnce(1700000000000);

    const { handleSettingsRoutes } = await import('@electron/api/routes/settings');

    await handleSettingsRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/settings/reset'),
      { gatewayManager: { getStatus: () => ({ state: 'stopped' }) } } as never,
    );

    expect(resetSettingsMock).toHaveBeenCalledTimes(1);
    expect(setSettingMock).toHaveBeenCalledWith('trialStartAt', 1700000000000);
  });
});
