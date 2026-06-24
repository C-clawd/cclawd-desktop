import { describe, expect, it } from 'vitest';
import {
  buildProviderListItems,
} from '@/lib/provider-accounts';
import type {
  ProviderAccount,
  ProviderVendorInfo,
  ProviderWithKeyInfo,
} from '@/lib/providers';

function makeAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'moonshot',
    vendorId: 'moonshot' as ProviderAccount['vendorId'],
    label: 'Moonshot',
    authMode: 'api_key',
    enabled: true,
    isDefault: false,
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    ...overrides,
  };
}

function makeVendor(overrides: Partial<ProviderVendorInfo> = {}): ProviderVendorInfo {
  return {
    id: 'moonshot' as ProviderVendorInfo['id'],
    name: 'Moonshot',
    icon: 'M',
    requiresApiKey: true,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.moonshot.cn',
    apiKeyUrl: 'https://platform.moonshot.cn',
    showBaseUrl: false,
    showModelId: false,
    ...overrides,
  };
}

describe('provider account list helpers', () => {
  it('does not crash when provider statuses are not returned as an array', () => {
    const items = buildProviderListItems(
      [makeAccount()],
      { success: false, error: 'Provider not found' } as unknown as ProviderWithKeyInfo[],
      [makeVendor()],
      'moonshot',
    );

    expect(items).toHaveLength(1);
    expect(items[0].account.id).toBe('moonshot');
    expect(items[0].status).toBeUndefined();
  });
});
