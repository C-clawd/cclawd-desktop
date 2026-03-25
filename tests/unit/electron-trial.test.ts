import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSettingMock = vi.fn();
const setSettingMock = vi.fn();
const readOpenClawEnvMock = vi.fn();

vi.mock('@electron/utils/store', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
  setSetting: (...args: unknown[]) => setSettingMock(...args),
}));

vi.mock('@electron/utils/openclaw-env', () => ({
  readOpenClawEnv: (...args: unknown[]) => readOpenClawEnvMock(...args),
}));

describe('electron trial utilities', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('starts trial automatically when a saved MFA key exists', async () => {
    getSettingMock.mockResolvedValueOnce(0);
    readOpenClawEnvMock.mockResolvedValueOnce({
      entries: [{ key: 'MFA_AUTH_API_KEY', value: 'saved-key' }],
    });

    const { ensureTrialStartAt } = await import('@electron/utils/trial');
    const startAt = await ensureTrialStartAt();

    expect(startAt).toBeTypeOf('number');
    expect(startAt).toBeGreaterThan(0);
    expect(setSettingMock).toHaveBeenCalledWith('trialStartAt', startAt);
  });

  it('does not start trial without a saved MFA key', async () => {
    getSettingMock.mockResolvedValueOnce(0);
    readOpenClawEnvMock.mockResolvedValueOnce({
      entries: [],
    });

    const { ensureTrialStartAt } = await import('@electron/utils/trial');
    const startAt = await ensureTrialStartAt();

    expect(startAt).toBe(0);
    expect(setSettingMock).not.toHaveBeenCalled();
  });
});
