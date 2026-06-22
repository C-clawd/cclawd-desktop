/**
 * Persistent Storage
 * Electron-store wrapper for application settings
 */

import { randomBytes } from 'crypto';
import { app } from 'electron';
import { resolveSupportedLanguage } from '../../shared/language';
import { syncRealPersonAuthEnabledToEnv } from './real-person-auth-flag';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsStoreInstance: any = null;

/**
 * Generate a random token for gateway authentication
 */
function generateToken(): string {
  return `Cclawd-${randomBytes(16).toString('hex')}`;
}

/**
 * Application settings schema
 */
export interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';
  language: string;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;
  machineId: string;
  hasReportedInstall: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyHttpServer: string;
  proxyHttpsServer: string;
  proxyAllServer: string;
  proxyBypassRules: string;

  // Update
  updateChannel: 'stable' | 'beta' | 'dev';
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
  skippedVersions: string[];

  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;

  // Security
  periodicAuthEnabled: boolean;
  periodicAuthIntervalMs: number;
  periodicAuthLastVerifiedAt: number;
  periodicAuthLocked: boolean;
  realPersonAuthEnabled: boolean;

  // Trial
  trialStartAt: number;

  // Presets
  selectedBundles: string[];
  enabledSkills: string[];
  disabledSkills: string[];
  userRoleTags: string[];
  installedRolePresetVersion: number;
  installedRolePresetAt: number;
}

/**
 * Default settings
 */
function getSystemLocale(): string {
  const preferredLanguages = typeof app.getPreferredSystemLanguages === 'function'
    ? app.getPreferredSystemLanguages()
    : [];
  return preferredLanguages[0]
    || (typeof app.getLocale === 'function' ? app.getLocale() : '')
    || Intl.DateTimeFormat().resolvedOptions().locale
    || 'en';
}

function createDefaultSettings(): AppSettings {
  const defaultPeriodicAuthIntervalMs = app.isPackaged ? 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return {
    // General
    theme: 'light',
    language: resolveSupportedLanguage(getSystemLocale()),
    startMinimized: false,
    launchAtStartup: false,
    telemetryEnabled: true,
    machineId: '',
    hasReportedInstall: false,

    // Gateway
    gatewayAutoStart: true,
    gatewayPort: 18789,
    gatewayToken: generateToken(),
    proxyEnabled: false,
    proxyServer: '',
    proxyHttpServer: '',
    proxyHttpsServer: '',
    proxyAllServer: '',
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1',

    // Update
    updateChannel: 'stable',
    autoCheckUpdate: true,
    autoDownloadUpdate: false,
    skippedVersions: [],

    // UI State
    sidebarCollapsed: false,
    devModeUnlocked: false,

    // Security
    periodicAuthEnabled: false,
    periodicAuthIntervalMs: defaultPeriodicAuthIntervalMs,
    periodicAuthLastVerifiedAt: 0,
    periodicAuthLocked: false,
    realPersonAuthEnabled: false,

    // Trial
    trialStartAt: 0,

    // Presets
    selectedBundles: ['productivity', 'developer'],
    enabledSkills: [],
    disabledSkills: [],
    userRoleTags: [],
    installedRolePresetVersion: 0,
    installedRolePresetAt: 0,
  };
}

const REAL_PERSON_AUTH_OPT_IN_MIGRATION_KEY = 'realPersonAuthOptInMigrated_v1';

async function migrateRealPersonAuthToOptInDefault(store: {
  get: (key: string) => unknown;
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  if (store.get(REAL_PERSON_AUTH_OPT_IN_MIGRATION_KEY) === true) {
    return;
  }

  store.set('realPersonAuthEnabled', false);
  store.set('periodicAuthEnabled', false);
  store.set('periodicAuthLocked', false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store as any).set(REAL_PERSON_AUTH_OPT_IN_MIGRATION_KEY, true);
}

async function sanitizePeriodicAuthSettingsOnLoad(store: {
  get: <K extends keyof AppSettings>(key: K) => AppSettings[K];
  set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}) {
  const lastVerifiedAt = store.get('periodicAuthLastVerifiedAt');
  const locked = store.get('periodicAuthLocked');
  const intervalMs = store.get('periodicAuthIntervalMs');

  // In packaged apps, guard against accidental dev/test intervals
  // persisted from old builds or local debugging.
  if (app.isPackaged && intervalMs < 60 * 60 * 1000) {
    store.set('periodicAuthIntervalMs', 24 * 60 * 60 * 1000);
  }

  // If never verified, lock state should not trap users in a modal loop.
  if (lastVerifiedAt <= 0 && locked) {
    store.set('periodicAuthLocked', false);
  }
}

/**
 * Get the settings store instance (lazy initialization)
 */
async function getSettingsStore() {
  if (!settingsStoreInstance) {
    const Store = (await import('electron-store')).default;
    settingsStoreInstance = new Store<AppSettings>({
      name: 'settings',
      defaults: createDefaultSettings(),
    });
    await migrateRealPersonAuthToOptInDefault(settingsStoreInstance);
    await sanitizePeriodicAuthSettingsOnLoad(settingsStoreInstance);
    await syncRealPersonAuthEnabledToEnv(settingsStoreInstance.get('realPersonAuthEnabled'));
  }
  return settingsStoreInstance;
}

/**
 * Get a setting value
 */
export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const store = await getSettingsStore();
  return store.get(key);
}

/**
 * Set a setting value
 */
export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): Promise<void> {
  const store = await getSettingsStore();
  store.set(key, value);

  if (key === 'realPersonAuthEnabled') {
    const enabled = Boolean(value);
    store.set('periodicAuthEnabled', enabled);
    if (!enabled) {
      store.set('periodicAuthLocked', false);
    }
    await syncRealPersonAuthEnabledToEnv(enabled);
    return;
  }

  if (key === 'periodicAuthEnabled') {
    await syncRealPersonAuthEnabledToEnv(store.get('realPersonAuthEnabled'));
  }
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();
  return store.store;
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(): Promise<void> {
  const store = await getSettingsStore();
  store.clear();
}

/**
 * Export settings to JSON
 */
export async function exportSettings(): Promise<string> {
  const store = await getSettingsStore();
  return JSON.stringify(store.store, null, 2);
}

/**
 * Import settings from JSON
 */
export async function importSettings(json: string): Promise<void> {
  try {
    const settings = JSON.parse(json);
    const store = await getSettingsStore();
    store.set(settings);
  } catch {
    throw new Error('Invalid settings JSON');
  }
}
