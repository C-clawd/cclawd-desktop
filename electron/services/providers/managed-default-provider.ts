import type { GatewayManager } from '../../gateway/manager';
import type { ProviderAccount, ProviderConfig } from '../../shared/providers/types';
import { getProviderDefinition } from '../../shared/providers/registry';
import {
  getExplicitOpenClawProviders,
  getOpenClawProvidersConfig,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModelWithOverride,
} from '../../utils/openclaw-auth';
import { logger } from '../../utils/logger';
import {
  getDefaultProviderAccountId,
  getProviderAccount,
  listProviderAccounts,
  saveProviderAccount,
  setDefaultProviderAccount,
} from './provider-store';
import {
  describeLocalDefaultProvider,
  type LocalDefaultProviderConfig,
  resolveLocalDefaultProviderConfig,
} from './local-default-provider-config';

export const MANAGED_DEFAULT_PROVIDER_ID = 'cclawd-default';
export const MANAGED_DEFAULT_MODEL_ID = 'cclawd-auto';
export const MANAGED_DEFAULT_MODEL_REF = `${MANAGED_DEFAULT_PROVIDER_ID}/${MANAGED_DEFAULT_MODEL_ID}`;

export type ManagedDefaultProviderStatus =
  | 'user-provider-present'
  | 'managed-provider-ready'
  | 'managed-provider-created'
  | 'managed-provider-unconfigured';

export interface ManagedDefaultProviderResult {
  status: ManagedDefaultProviderStatus;
  accountId: string;
  modelRef: string;
}

function isManagedDefaultAccount(account: Pick<ProviderAccount, 'id' | 'vendorId' | 'authMode' | 'metadata'>): boolean {
  return account.id === MANAGED_DEFAULT_PROVIDER_ID
    || account.vendorId === MANAGED_DEFAULT_PROVIDER_ID
    || account.authMode === 'managed'
    || account.metadata?.origin === 'system';
}

export function isManagedDefaultProviderId(accountId: string | undefined | null): boolean {
  return accountId === MANAGED_DEFAULT_PROVIDER_ID;
}

export function isUserProviderAccount(account: ProviderAccount): boolean {
  return !isManagedDefaultAccount(account);
}

export function isManagedDefaultModelRef(modelRef: string | undefined): boolean {
  return modelRef?.startsWith(`${MANAGED_DEFAULT_PROVIDER_ID}/`) ?? false;
}

function toManagedModelRef(model: string): string {
  return model.startsWith(`${MANAGED_DEFAULT_PROVIDER_ID}/`)
    ? model
    : `${MANAGED_DEFAULT_PROVIDER_ID}/${model}`;
}

export function createManagedDefaultProviderAccount(
  now = new Date().toISOString(),
  localConfig: LocalDefaultProviderConfig | null = null,
): ProviderAccount {
  const definition = getProviderDefinition(MANAGED_DEFAULT_PROVIDER_ID);
  return {
    id: MANAGED_DEFAULT_PROVIDER_ID,
    vendorId: MANAGED_DEFAULT_PROVIDER_ID,
    label: definition?.name ?? 'Cclawd Default',
    authMode: 'managed',
    ...(localConfig ? describeLocalDefaultProvider(localConfig) : { model: MANAGED_DEFAULT_MODEL_ID }),
    enabled: Boolean(localConfig),
    isDefault: true,
    metadata: {
      origin: 'system',
      readonly: true,
    },
    createdAt: now,
    updatedAt: now,
  };
}

async function hasUserProviderConfiguration(): Promise<boolean> {
  const accounts = await listProviderAccounts();
  if (accounts.some((account) => account.enabled && isUserProviderAccount(account))) {
    return true;
  }

  const explicitProviders = await getExplicitOpenClawProviders();
  explicitProviders.delete(MANAGED_DEFAULT_PROVIDER_ID);
  return explicitProviders.size > 0;
}

async function upsertManagedDefaultAccount(
  localConfig: LocalDefaultProviderConfig | null,
): Promise<'created' | 'ready'> {
  const existing = await getProviderAccount(MANAGED_DEFAULT_PROVIDER_ID);
  const now = new Date().toISOString();
  const next = createManagedDefaultProviderAccount(now, localConfig);

  if (existing) {
    await saveProviderAccount({
      ...existing,
      ...next,
      createdAt: existing.createdAt || next.createdAt,
      updatedAt: now,
    });
    return 'ready';
  }

  await saveProviderAccount(next);
  return 'created';
}

function scheduleGatewayRefresh(gatewayManager: GatewayManager | undefined): void {
  if (!gatewayManager || gatewayManager.getStatus().state === 'stopped') {
    return;
  }
  gatewayManager.debouncedReload();
}

export async function ensureUsableDefaultProvider(options?: {
  gatewayManager?: GatewayManager;
  reason?: string;
}): Promise<ManagedDefaultProviderResult> {
  const { defaultModel } = await getOpenClawProvidersConfig();
  const userProviderPresent = await hasUserProviderConfiguration();

  if (userProviderPresent && !isManagedDefaultModelRef(defaultModel)) {
    return {
      status: 'user-provider-present',
      accountId: (await getDefaultProviderAccountId()) ?? MANAGED_DEFAULT_PROVIDER_ID,
      modelRef: defaultModel ?? MANAGED_DEFAULT_MODEL_REF,
    };
  }

  const localConfig = await resolveLocalDefaultProviderConfig();
  const accountStatus = await upsertManagedDefaultAccount(localConfig);

  if (!localConfig) {
    return {
      status: 'managed-provider-unconfigured',
      accountId: MANAGED_DEFAULT_PROVIDER_ID,
      modelRef: defaultModel ?? MANAGED_DEFAULT_MODEL_REF,
    };
  }

  await setDefaultProviderAccount(MANAGED_DEFAULT_PROVIDER_ID);
  await saveProviderKeyToOpenClaw(MANAGED_DEFAULT_PROVIDER_ID, localConfig.apiKey);
  const modelRef = toManagedModelRef(localConfig.model);
  await setOpenClawDefaultModelWithOverride(
    MANAGED_DEFAULT_PROVIDER_ID,
    modelRef,
    {
      baseUrl: localConfig.baseUrl,
      api: localConfig.api,
      apiKeyEnv: localConfig.apiKeyEnv,
      headers: localConfig.headers,
    },
  );

  logger.info(
    `[provider-bootstrap] Set local default provider (${options?.reason ?? 'unspecified'})`,
  );
  scheduleGatewayRefresh(options?.gatewayManager);

  return {
    status: accountStatus === 'created' ? 'managed-provider-created' : 'managed-provider-ready',
    accountId: MANAGED_DEFAULT_PROVIDER_ID,
    modelRef,
  };
}

export function providerConfigIsManagedDefault(config: ProviderConfig | null | undefined): boolean {
  return Boolean(config && config.id === MANAGED_DEFAULT_PROVIDER_ID);
}
