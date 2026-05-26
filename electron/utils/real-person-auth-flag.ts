import {
  CCLAWD_REAL_PERSON_AUTH_ENABLED_KEY,
  formatRealPersonAuthEnabledFlag,
} from '../../shared/real-person-auth-flag';
import { readOpenClawEnv, writeOpenClawEnv, type OpenClawEnvEntry } from './openclaw-env';

function upsertEnvEntry(entries: OpenClawEnvEntry[], key: string, value: string): OpenClawEnvEntry[] {
  let updated = false;
  const nextEntries = entries.map((entry) => {
    if (entry.key !== key) {
      return entry;
    }
    updated = true;
    return { key, value };
  });

  if (!updated) {
    nextEntries.push({ key, value });
  }

  return nextEntries;
}

export async function syncRealPersonAuthEnabledToEnv(enabled: boolean): Promise<void> {
  const current = await readOpenClawEnv();
  const nextEntries = upsertEnvEntry(
    current.entries,
    CCLAWD_REAL_PERSON_AUTH_ENABLED_KEY,
    formatRealPersonAuthEnabledFlag(enabled),
  );
  await writeOpenClawEnv(nextEntries);
}
