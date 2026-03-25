import { getSetting, setSetting } from './store';
import { readOpenClawEnv } from './openclaw-env';
import {
  getRemainingTrialDays,
  getTrialEndAt,
  hasTrialStarted,
  isTrialExpired,
} from '../../shared/trial';

const MFA_AUTH_API_KEY = 'MFA_AUTH_API_KEY';

async function hasSavedTrialAuthKey(): Promise<boolean> {
  const env = await readOpenClawEnv();
  return env.entries.some((entry) => entry.key === MFA_AUTH_API_KEY && entry.value.trim().length > 0);
}

export async function ensureTrialStartAt(): Promise<number> {
  const current = await getSetting('trialStartAt');
  if (hasTrialStarted(current)) {
    return current;
  }

  if (!(await hasSavedTrialAuthKey())) {
    return 0;
  }

  const startedAt = Date.now();
  await setSetting('trialStartAt', startedAt);
  return startedAt;
}

export async function getTrialState(nowMs = Date.now()) {
  const trialStartAt = await ensureTrialStartAt();
  const trialEndAt = getTrialEndAt(trialStartAt);

  return {
    trialStartAt,
    trialEndAt,
    trialStarted: hasTrialStarted(trialStartAt),
    expired: isTrialExpired(trialStartAt, nowMs),
    remainingDays: getRemainingTrialDays(trialStartAt, nowMs),
  };
}
