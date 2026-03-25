const DAY_MS = 24 * 60 * 60 * 1000;

export const TRIAL_TOTAL_DAYS = 30;
export const TRIAL_TOTAL_MS = TRIAL_TOTAL_DAYS * DAY_MS;
const TRIAL_ALLOWED_ROUTES = [
  { pathname: '/api/settings', method: 'GET' },
];

export function hasTrialStarted(trialStartAt: number): boolean {
  return Number.isFinite(trialStartAt) && trialStartAt > 0;
}

export function getTrialDaysElapsed(trialStartAt: number, nowMs = Date.now()): number {
  if (!hasTrialStarted(trialStartAt)) return 0;
  return Math.max(0, Math.floor((nowMs - trialStartAt) / DAY_MS));
}

export function getRemainingTrialDays(trialStartAt: number, nowMs = Date.now()): number {
  if (!hasTrialStarted(trialStartAt)) return TRIAL_TOTAL_DAYS;
  return Math.max(0, TRIAL_TOTAL_DAYS - getTrialDaysElapsed(trialStartAt, nowMs));
}

export function getTrialEndAt(trialStartAt: number): number {
  if (!hasTrialStarted(trialStartAt)) return 0;
  return trialStartAt + TRIAL_TOTAL_MS;
}

export function isTrialExpired(trialStartAt: number, nowMs = Date.now()): boolean {
  const trialEndAt = getTrialEndAt(trialStartAt);
  return trialEndAt > 0 && nowMs >= trialEndAt;
}

export function shouldBlockExpiredTrialRequest(pathname: string, method: string): boolean {
  return !TRIAL_ALLOWED_ROUTES.some((route) => route.pathname === pathname && route.method === method);
}
