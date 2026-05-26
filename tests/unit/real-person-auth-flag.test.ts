import { describe, expect, it } from 'vitest';
import {
  CCLAWD_REAL_PERSON_AUTH_ENABLED_KEY,
  formatRealPersonAuthEnabledFlag,
  parseRealPersonAuthEnabledFlag,
} from '../../shared/real-person-auth-flag';

describe('real-person-auth-flag', () => {
  it('defaults to disabled when env value is missing', () => {
    expect(parseRealPersonAuthEnabledFlag(undefined)).toBe(false);
  });

  it('accepts common enabled values', () => {
    expect(parseRealPersonAuthEnabledFlag('1')).toBe(true);
    expect(parseRealPersonAuthEnabledFlag('true')).toBe(true);
    expect(parseRealPersonAuthEnabledFlag('YES')).toBe(true);
  });

  it('formats enabled state for ~/.openclaw/.env', () => {
    expect(formatRealPersonAuthEnabledFlag(true)).toBe('1');
    expect(formatRealPersonAuthEnabledFlag(false)).toBe('0');
    expect(CCLAWD_REAL_PERSON_AUTH_ENABLED_KEY).toBe('CCLAWD_REAL_PERSON_AUTH_ENABLED');
  });
});
