/** Shared env flag read by Desktop host and the Feishu gateway plugin. */
export const CCLAWD_REAL_PERSON_AUTH_ENABLED_KEY = 'CCLAWD_REAL_PERSON_AUTH_ENABLED';

export function parseRealPersonAuthEnabledFlag(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function formatRealPersonAuthEnabledFlag(enabled: boolean): string {
  return enabled ? '1' : '0';
}
