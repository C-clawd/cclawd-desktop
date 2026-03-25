import { describe, expect, it } from 'vitest';
import {
  TRIAL_TOTAL_DAYS,
  getRemainingTrialDays,
  getTrialEndAt,
  hasTrialStarted,
  isTrialExpired,
  shouldBlockExpiredTrialRequest,
} from '../../shared/trial';

describe('trial helpers', () => {
  it('treats non-positive timestamps as not started', () => {
    expect(hasTrialStarted(0)).toBe(false);
    expect(getRemainingTrialDays(0)).toBe(TRIAL_TOTAL_DAYS);
    expect(isTrialExpired(0)).toBe(false);
  });

  it('computes remaining days and expiry from the start timestamp', () => {
    const startAt = Date.UTC(2026, 0, 1);
    const day29 = startAt + 29 * 24 * 60 * 60 * 1000;
    const day30 = getTrialEndAt(startAt);

    expect(getRemainingTrialDays(startAt, day29)).toBe(1);
    expect(isTrialExpired(startAt, day29)).toBe(false);
    expect(isTrialExpired(startAt, day30)).toBe(true);
  });
});

describe('expired trial api access', () => {
  it('allows settings and app routes so the lock screen can still function', () => {
    expect(shouldBlockExpiredTrialRequest('/api/settings', 'GET')).toBe(false);
  });

  it('blocks writes and core feature routes', () => {
    expect(shouldBlockExpiredTrialRequest('/api/settings', 'PUT')).toBe(true);
    expect(shouldBlockExpiredTrialRequest('/api/gateway/rpc', 'POST')).toBe(true);
    expect(shouldBlockExpiredTrialRequest('/api/sessions', 'GET')).toBe(true);
    expect(shouldBlockExpiredTrialRequest('/api/usage/recent-token-history', 'GET')).toBe(true);
  });
});
