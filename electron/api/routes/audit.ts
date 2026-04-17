import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

type GuardRegisterResponse = {
  success?: boolean;
  agent?: {
    id?: string;
    api_key?: string;
  };
};

type StoredGuardCredentials = {
  apiKey?: string;
  agentId?: string;
  machineId?: string;
  orgToken?: string;
  orgId?: string;
  userId?: string;
  coreUrl?: string;
};

const DEFAULT_GUARD_BASE_URL = 'https://cclawd.dbhl.cn/cclawd-guard-core';
const OPENCLAW_CONFIG_FILE = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const OPENCLAW_ENV_FILE = path.join(os.homedir(), '.openclaw', '.env');

function readGuardBaseUrlFromOpenClawConfig(): string {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG_FILE)) return '';
    const raw = fs.readFileSync(OPENCLAW_CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const plugins = parsed.plugins as Record<string, unknown> | undefined;
    const entries = plugins?.entries as Record<string, unknown> | undefined;
    const guardEntry = entries?.['cclawd-guard'] as Record<string, unknown> | undefined;
    const pluginConfig = guardEntry?.config as Record<string, unknown> | undefined;
    const coreUrl = typeof pluginConfig?.coreUrl === 'string' ? pluginConfig.coreUrl.trim() : '';
    return coreUrl ? coreUrl.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

const GUARD_BASE_URL = (
  process.env.CCLAWD_GUARD_BASE_URL?.trim()
  || readGuardBaseUrlFromOpenClawConfig()
  || DEFAULT_GUARD_BASE_URL
).replace(/\/$/, '');
const SHARED_CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.openclaw',
  'credentials',
  'cclawd-guard',
  'credentials.json',
);

let cachedGuardAgentId = '';
let cachedGuardApiKey = '';
let cachedOrgToken = '';
let cachedMachineId = '';
let pendingGuardAuthPromise: Promise<{ agentId: string; apiKey: string }> | null = null;

function isGeneratedMachineId(value: string): boolean {
  return value.startsWith('mid_') && value.length > 12;
}

async function parseGuardJson<T>(response: Response): Promise<T | null> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null;
  }
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

type GuardApiResponse<T> = {
  success?: boolean;
  data?: T;
  error?: string;
};

type OrgMeData = {
  user?: {
    status?: string;
  };
  subscription?: {
    status?: string;
    endAt?: string;
  };
  hasSeat?: boolean;
};

const ORG_LOGIN_ERROR_CODES = {
  MISSING_CREDENTIALS: 'ORG_LOGIN_MISSING_CREDENTIALS',
  INVALID_CREDENTIALS: 'ORG_LOGIN_INVALID_CREDENTIALS',
  FAILED: 'ORG_LOGIN_FAILED',
} as const;

type OrgLoginErrorCode = typeof ORG_LOGIN_ERROR_CODES[keyof typeof ORG_LOGIN_ERROR_CODES];

const ENTITLEMENT_REASON_CODES = {
  OK: 'ok',
  TRANSIENT: 'transient',
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
  NO_AVAILABLE_SEATS: 'no_available_seats',
  SEAT_NOT_ASSIGNED: 'seat_not_assigned',
  ORG_USER_INACTIVE: 'org_user_inactive',
  ORG_AUTH_INVALID: 'org_auth_invalid',
  ORG_AUTH_MISSING: 'org_auth_missing',
  BIND_402: 'bind_402',
  BIND_403: 'bind_403',
  UNKNOWN: 'unknown',
} as const;

type EntitlementReasonCode = typeof ENTITLEMENT_REASON_CODES[keyof typeof ENTITLEMENT_REASON_CODES];

const REL_LOGIN_REASON_CODES = new Set<EntitlementReasonCode>([
  ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE,
  ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
  ENTITLEMENT_REASON_CODES.ORG_AUTH_MISSING,
  ENTITLEMENT_REASON_CODES.BIND_403,
]);

type OrgAuthData = {
  token?: string;
  orgId?: string;
  userId?: string;
};

type OrgAuthResult = {
  data: OrgAuthData | null;
  status: number;
  error: string;
};

type OrgConfig = {
  token: string;
  email: string;
  password: string;
  name: string;
};

type OrgLoginBody = {
  email?: string;
  password?: string;
};

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length >= 2) {
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function readOpenClawEnvMap(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    if (!fs.existsSync(OPENCLAW_ENV_FILE)) return map;
    const raw = fs.readFileSync(OPENCLAW_ENV_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      if (!key) continue;
      const value = stripWrappingQuotes(line.slice(idx + 1));
      if (!map.has(key)) {
        map.set(key, value);
      }
    }
  } catch {
    // Best effort only.
  }
  return map;
}

function getOrgConfig(): OrgConfig {
  const envMap = readOpenClawEnvMap();
  const token = (
    process.env.CCLAWD_GUARD_ORG_TOKEN?.trim()
    || envMap.get('CCLAWD_GUARD_ORG_TOKEN')
    || ''
  ).trim();
  const email = (
    process.env.CCLAWD_GUARD_ORG_EMAIL?.trim()
    || envMap.get('CCLAWD_GUARD_ORG_EMAIL')
    || ''
  ).trim().toLowerCase();
  const password = (
    process.env.CCLAWD_GUARD_ORG_PASSWORD?.trim()
    || envMap.get('CCLAWD_GUARD_ORG_PASSWORD')
    || ''
  ).trim();
  const name = (
    process.env.CCLAWD_GUARD_ORG_NAME?.trim()
    || envMap.get('CCLAWD_GUARD_ORG_NAME')
    || 'Cclawd Enterprise'
  ).trim();
  return { token, email, password, name };
}

function loadSharedGuardCredentials(): StoredGuardCredentials | null {
  try {
    if (!fs.existsSync(SHARED_CREDENTIALS_FILE)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(SHARED_CREDENTIALS_FILE, 'utf-8')) as StoredGuardCredentials;
    const agentId = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    const issuedCoreUrl = typeof parsed.coreUrl === 'string' ? parsed.coreUrl.replace(/\/$/, '') : '';
    if (!agentId || !apiKey) {
      return null;
    }
    if (issuedCoreUrl && issuedCoreUrl !== GUARD_BASE_URL) {
      return null;
    }
    return {
      agentId,
      apiKey,
      machineId: typeof parsed.machineId === 'string' ? parsed.machineId.trim() : '',
      orgToken: typeof parsed.orgToken === 'string' ? parsed.orgToken.trim() : '',
      orgId: typeof parsed.orgId === 'string' ? parsed.orgId.trim() : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId.trim() : '',
      coreUrl: issuedCoreUrl,
    };
  } catch {
    return null;
  }
}

function saveSharedGuardCredentials(next: StoredGuardCredentials): void {
  try {
    const dir = path.dirname(SHARED_CREDENTIALS_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const current = loadSharedGuardCredentials() || {};
    const payload: StoredGuardCredentials = {
      ...current,
      ...next,
      coreUrl: GUARD_BASE_URL,
    };
    fs.writeFileSync(SHARED_CREDENTIALS_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Best effort only.
  }
}

function clearGuardAuthState(): void {
  cachedGuardAgentId = '';
  cachedGuardApiKey = '';
  cachedOrgToken = '';
  pendingGuardAuthPromise = null;
  saveSharedGuardCredentials({
    orgToken: '',
    orgId: '',
    userId: '',
    agentId: '',
    apiKey: '',
  });
}

async function performOrgLogin(email: string, password: string): Promise<OrgAuthData> {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedPassword = password.trim();
  if (!normalizedEmail || !normalizedPassword) {
    throw new Error('Email and password are required');
  }

  const login = await loginOrg(normalizedEmail, normalizedPassword);
  const org = login.data;
  if (!org?.token) {
    const detail = login.error || 'Failed to login guard org account';
    throw new Error(detail);
  }

  cachedOrgToken = org.token;
  cachedGuardAgentId = '';
  cachedGuardApiKey = '';
  pendingGuardAuthPromise = null;
  saveSharedGuardCredentials({
    orgToken: org.token,
    orgId: org.orgId,
    userId: org.userId,
    agentId: '',
    apiKey: '',
  });

  return org;
}

async function isValidGuardApiKey(apiKey: string): Promise<boolean> {
  try {
    const response = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/account`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isValidOrgToken(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  try {
    const response = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/org/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      return false;
    }
    const payload = await parseGuardJson<GuardApiResponse<Record<string, unknown>>>(response);
    return Boolean(payload?.success);
  } catch {
    return false;
  }
}

function parseGuardErrorMessage(payload: GuardApiResponse<unknown> | null, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error.trim();
  }
  if (payload.error && typeof payload.error === 'object') {
    try {
      const text = JSON.stringify(payload.error);
      if (text && text !== '{}') return text;
    } catch {
      // ignore
    }
  }
  return fallback;
}

function getOrgLoginMessageZh(code?: OrgLoginErrorCode, fallback?: string): string {
  switch (code) {
    case ORG_LOGIN_ERROR_CODES.MISSING_CREDENTIALS:
      return '请输入邮箱和密码';
    case ORG_LOGIN_ERROR_CODES.INVALID_CREDENTIALS:
      return '邮箱或密码错误，请检查后重试';
    case ORG_LOGIN_ERROR_CODES.FAILED:
      return '登录失败，请稍后重试';
    default:
      return fallback || '登录失败，请稍后重试';
  }
}

function getEntitlementMessageZh(reasonCode?: string, fallback?: string): string {
  switch ((reasonCode || '').toLowerCase()) {
    case ENTITLEMENT_REASON_CODES.ORG_AUTH_MISSING:
      return '当前未登录企业账号，请登录后继续';
    case ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID:
      return '组织认证失败，请重新登录企业账号';
    case ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE:
      return '当前组织账号不可用，请联系管理员处理';
    case ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE:
      return '订阅已过期或未激活，请联系管理员续费后重试';
    case ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED:
      return '当前账号未分配席位，请联系管理员分配后重试';
    case ENTITLEMENT_REASON_CODES.NO_AVAILABLE_SEATS:
      return '当前企业席位已用完，请联系管理员扩容席位';
    case ENTITLEMENT_REASON_CODES.BIND_402:
      return '当前账号无可用订阅或席位，暂无法使用企业能力';
    case ENTITLEMENT_REASON_CODES.BIND_403:
      return '当前组织账号不可用，请重新登录后重试';
    default:
      return fallback || '企业权限校验失败，请稍后重试';
  }
}

function mapOrgLoginError(rawError: unknown): { code: OrgLoginErrorCode; message: string } {
  const raw = String(rawError ?? '');
  const lower = raw.toLowerCase();
  if (lower.includes('email and password are required')) {
    return {
      code: ORG_LOGIN_ERROR_CODES.MISSING_CREDENTIALS,
      message: getOrgLoginMessageZh(ORG_LOGIN_ERROR_CODES.MISSING_CREDENTIALS),
    };
  }
  if (
    lower.includes('invalid api key')
    || lower.includes('api key 无效')
    || lower.includes('invalid email or password')
    || lower.includes('邮箱或密码错误')
    || lower.includes('login failed: http 401')
    || lower.includes('login failed: http 403')
    || lower.includes('failed to login guard org account')
  ) {
    return {
      code: ORG_LOGIN_ERROR_CODES.INVALID_CREDENTIALS,
      message: getOrgLoginMessageZh(ORG_LOGIN_ERROR_CODES.INVALID_CREDENTIALS),
    };
  }
  return {
    code: ORG_LOGIN_ERROR_CODES.FAILED,
    message: getOrgLoginMessageZh(ORG_LOGIN_ERROR_CODES.FAILED),
  };
}

async function loginOrg(email: string, password: string): Promise<OrgAuthResult> {
  const response = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/org/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const payload = await parseGuardJson<GuardApiResponse<OrgAuthData>>(response);
  if (!response.ok || !payload?.success || !payload.data?.token) {
    return {
      data: null,
      status: response.status,
      error: parseGuardErrorMessage(payload, `Login failed: HTTP ${response.status}`),
    };
  }
  return { data: payload.data, status: response.status, error: '' };
}

async function registerOrg(orgName: string, email: string, password: string): Promise<OrgAuthResult> {
  const response = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/org/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ orgName, email, password }),
  });
  const payload = await parseGuardJson<GuardApiResponse<OrgAuthData>>(response);
  if (!response.ok || !payload?.success || !payload.data?.token) {
    return {
      data: null,
      status: response.status,
      error: parseGuardErrorMessage(payload, `Register failed: HTTP ${response.status}`),
    };
  }
  return { data: payload.data, status: response.status, error: '' };
}

async function ensureOrgToken(): Promise<OrgAuthData> {
  const orgConfig = getOrgConfig();

  if (cachedOrgToken && await isValidOrgToken(cachedOrgToken)) {
    return { token: cachedOrgToken };
  }

  if (orgConfig.token && await isValidOrgToken(orgConfig.token)) {
    cachedOrgToken = orgConfig.token;
    return { token: orgConfig.token };
  }

  const shared = loadSharedGuardCredentials();
  const sharedToken = shared?.orgToken || '';
  if (sharedToken && await isValidOrgToken(sharedToken)) {
    cachedOrgToken = sharedToken;
    return {
      token: sharedToken,
      orgId: shared?.orgId || '',
      userId: shared?.userId || '',
    };
  }

  if (!orgConfig.email || !orgConfig.password) {
    throw new Error(
      'Missing org auth config: set CCLAWD_GUARD_ORG_TOKEN or both CCLAWD_GUARD_ORG_EMAIL and CCLAWD_GUARD_ORG_PASSWORD',
    );
  }

  const login = await loginOrg(orgConfig.email, orgConfig.password);
  let org = login.data;

  if (!org?.token) {
    // For auth/permission failures, surface precise login error instead of blind register fallback.
    if (login.status === 401 || login.status === 403) {
      throw new Error(login.error || 'Failed to login guard org account');
    }
    const registered = await registerOrg(orgConfig.name, orgConfig.email, orgConfig.password);
    org = registered.data;
    if (!org?.token) {
      const detail = registered.error || login.error || 'unknown error';
      throw new Error(`Failed to login/register guard org account: ${detail}`);
    }
  }

  cachedOrgToken = org.token;
  saveSharedGuardCredentials({
    orgToken: org.token,
    orgId: org.orgId,
    userId: org.userId,
  });
  return org;
}

async function ensureGuardAuth(): Promise<{ agentId: string; apiKey: string }> {
  if (pendingGuardAuthPromise) {
    return await pendingGuardAuthPromise;
  }

  pendingGuardAuthPromise = (async () => {
  if (cachedGuardAgentId && cachedGuardApiKey) {
    return { agentId: cachedGuardAgentId, apiKey: cachedGuardApiKey };
  }

  const sharedCredentials = loadSharedGuardCredentials();
  if (sharedCredentials?.apiKey && sharedCredentials?.agentId && await isValidGuardApiKey(sharedCredentials.apiKey)) {
    cachedGuardAgentId = sharedCredentials.agentId;
    cachedGuardApiKey = sharedCredentials.apiKey;
    if (sharedCredentials.machineId && isGeneratedMachineId(sharedCredentials.machineId)) {
      cachedMachineId = sharedCredentials.machineId;
    }
    if (sharedCredentials.orgToken) {
      cachedOrgToken = sharedCredentials.orgToken;
    }
    return sharedCredentials;
  }

  const org = await ensureOrgToken();
  const orgToken = org.token || cachedOrgToken;
  const machineId = await getCurrentMachineId();
  const bindResponse = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/agents/bind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${orgToken}`,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      machineId,
      name: `cclawd-desktop-${machineId}`,
      description: 'Desktop audit dashboard access',
    }),
  });
  const payload = await parseGuardJson<GuardRegisterResponse>(bindResponse);
  const agentId = payload?.agent?.id ?? '';
  const apiKey = payload?.agent?.api_key ?? '';

  if (!bindResponse.ok || !payload?.success || !agentId || !apiKey) {
    throw new Error(`Failed to bind guard agent: HTTP ${bindResponse.status}`);
  }

  cachedGuardAgentId = agentId;
  cachedGuardApiKey = apiKey;
  saveSharedGuardCredentials({
    machineId,
    orgToken,
    orgId: org.orgId,
    userId: org.userId,
    agentId,
    apiKey,
  });
  return { agentId, apiKey };
  })();

  try {
    return await pendingGuardAuthPromise;
  } finally {
    pendingGuardAuthPromise = null;
  }
}

function classifyEntitlementError(rawError: unknown): { code: EntitlementReasonCode; message: string } {
  const raw = String(rawError ?? '');
  const lower = raw.toLowerCase();
  if (lower.includes('subscription is inactive or expired')) {
    return {
      code: ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE),
    };
  }
  if (lower.includes('订阅未激活或已过期')) {
    return {
      code: ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE),
    };
  }
  if (lower.includes('no available seats')) {
    return {
      code: ENTITLEMENT_REASON_CODES.NO_AVAILABLE_SEATS,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.NO_AVAILABLE_SEATS),
    };
  }
  if (lower.includes('无可用席位')) {
    return {
      code: ENTITLEMENT_REASON_CODES.NO_AVAILABLE_SEATS,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.NO_AVAILABLE_SEATS),
    };
  }
  if (lower.includes('seat is not assigned')) {
    return {
      code: ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED),
    };
  }
  if (lower.includes('未分配席位')) {
    return {
      code: ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED),
    };
  }
  if (lower.includes('organization user is inactive')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE),
    };
  }
  if (lower.includes('组织账号已停用') || lower.includes('组织账号不可用')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE),
    };
  }
  if (lower.includes('invalid email or password')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID),
    };
  }
  if (lower.includes('邮箱或密码错误')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID),
    };
  }
  if (lower.includes('invalid api key')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID),
    };
  }
  if (lower.includes('failed to login/register guard org account') || lower.includes('failed to login guard org account')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID),
    };
  }
  if (lower.includes('login failed: http 401') || lower.includes('login failed: http 403')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_INVALID),
    };
  }
  if (lower.includes('missing org auth config')) {
    return {
      code: ENTITLEMENT_REASON_CODES.ORG_AUTH_MISSING,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_AUTH_MISSING),
    };
  }
  if (lower.includes('failed to bind guard agent: http 402')) {
    return {
      code: ENTITLEMENT_REASON_CODES.BIND_402,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.BIND_402),
    };
  }
  if (lower.includes('failed to bind guard agent: http 403')) {
    return {
      code: ENTITLEMENT_REASON_CODES.BIND_403,
      message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.BIND_403),
    };
  }
  return {
    code: ENTITLEMENT_REASON_CODES.UNKNOWN,
    message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.UNKNOWN),
  };
}

async function checkGuardEntitlement(): Promise<{ allowed: boolean; reasonCode: string; message: string; requireRelogin: boolean }> {
  try {
    const org = await ensureOrgToken();
    const token = org.token || cachedOrgToken;
    const response = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/org/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    const payload = await parseGuardJson<GuardApiResponse<OrgMeData>>(response);
    if (!response.ok || !payload?.success || !payload.data) {
      const detail = parseGuardErrorMessage(payload, `Org me failed: HTTP ${response.status}`);
      const mapped = classifyEntitlementError(detail);
      return {
        allowed: false,
        reasonCode: mapped.code,
        message: mapped.message,
        requireRelogin: REL_LOGIN_REASON_CODES.has(mapped.code),
      };
    }

    const data = payload.data;
    const userStatus = (data.user?.status || '').toLowerCase();
    const hasSeat = Boolean(data.hasSeat);
    const subStatus = (data.subscription?.status || '').toLowerCase();
    const subEndAtRaw = data.subscription?.endAt || '';
    const subEndAt = subEndAtRaw ? Date.parse(subEndAtRaw) : Number.NaN;
    const subscriptionValid = subStatus === 'active' && Number.isFinite(subEndAt) && subEndAt > Date.now();

    if (userStatus !== 'active') {
      return {
        allowed: false,
        reasonCode: ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE,
        message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.ORG_USER_INACTIVE),
        requireRelogin: true,
      };
    }
    if (!subscriptionValid) {
      return {
        allowed: false,
        reasonCode: ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE,
        message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SUBSCRIPTION_INACTIVE),
        requireRelogin: false,
      };
    }
    if (!hasSeat) {
      return {
        allowed: false,
        reasonCode: ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED,
        message: getEntitlementMessageZh(ENTITLEMENT_REASON_CODES.SEAT_NOT_ASSIGNED),
        requireRelogin: false,
      };
    }

    // Final bind-path validation to ensure machine authorization is also usable.
    await ensureGuardAuth();
    return { allowed: true, reasonCode: ENTITLEMENT_REASON_CODES.OK, message: '', requireRelogin: false };
  } catch (error) {
    const mapped = classifyEntitlementError(error);
    // Network/transient failures should not hard-lock the whole desktop.
    if (mapped.code === ENTITLEMENT_REASON_CODES.UNKNOWN) {
      return { allowed: true, reasonCode: ENTITLEMENT_REASON_CODES.TRANSIENT, message: '', requireRelogin: false };
    }
    return {
      allowed: false,
      reasonCode: mapped.code,
      message: mapped.message,
      requireRelogin: REL_LOGIN_REASON_CODES.has(mapped.code),
    };
  }
}

async function getCurrentMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;

  const shared = loadSharedGuardCredentials();
  if (shared?.machineId && isGeneratedMachineId(shared.machineId)) {
    cachedMachineId = shared.machineId;
    return cachedMachineId;
  }

  const generatedMachineId = `mid_${randomUUID().replace(/-/g, '')}`;
  cachedMachineId = generatedMachineId;
  saveSharedGuardCredentials({ machineId: generatedMachineId });
  return cachedMachineId;
}

async function proxyGuardGet(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPathWithQuery: string,
): Promise<void> {
  const auth = await ensureGuardAuth();
  const upstream = upstreamPathWithQuery;
  let response = await proxyAwareFetch(`${GUARD_BASE_URL}${upstream}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${auth.apiKey}`,
      Accept: 'application/json',
    },
  });

  if (response.status === 401) {
    cachedGuardAgentId = '';
    cachedGuardApiKey = '';
    cachedOrgToken = '';
    const refreshed = await ensureGuardAuth();
    response = await proxyAwareFetch(`${GUARD_BASE_URL}${upstream}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${refreshed.apiKey}`,
        Accept: 'application/json',
      },
    });
  }

  const body = await parseGuardJson<unknown>(response);
  if (!response.ok) {
    sendJson(res, response.status, {
      success: false,
      error: body ?? `Guard API request failed: ${response.status}`,
    });
    return;
  }

  sendJson(res, 200, body ?? { success: false, error: 'Invalid Guard API response' });
}

export async function handleAuditRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  try {
    if (url.pathname === '/api/audit/org-login' && req.method === 'POST') {
      try {
        const body = await parseJsonBody<OrgLoginBody>(req);
        const email = typeof body.email === 'string' ? body.email : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const org = await performOrgLogin(email, password);
        sendJson(res, 200, {
          success: true,
          data: {
            orgId: org.orgId || '',
            userId: org.userId || '',
          },
        });
      } catch (error) {
        const mapped = mapOrgLoginError(error);
        sendJson(res, 200, {
          success: false,
          code: mapped.code,
          error: mapped.message,
        });
      }
      return true;
    }

    if (url.pathname === '/api/audit/relogin' && req.method === 'POST') {
      clearGuardAuthState();
      sendJson(res, 200, { success: true });
      return true;
    }

    if (req.method !== 'GET') {
      return false;
    }

    if (url.pathname === '/api/audit/entitlement') {
      const status = await checkGuardEntitlement();
      sendJson(res, 200, {
        success: true,
        data: status,
      });
      return true;
    }

    if (url.pathname === '/api/audit/overview') {
      await proxyGuardGet(req, res, `/api/v1/audit/overview${url.search}`);
      return true;
    }

    if (url.pathname === '/api/audit/timeline') {
      await proxyGuardGet(req, res, `/api/v1/audit/timeline${url.search}`);
      return true;
    }

    if (url.pathname === '/api/audit/top-risks') {
      await proxyGuardGet(req, res, `/api/v1/audit/top-risks${url.search}`);
      return true;
    }

    if (url.pathname === '/api/audit/events') {
      await proxyGuardGet(req, res, `/api/v1/audit/events${url.search}`);
      return true;
    }
  } catch (error) {
    sendJson(res, 502, { success: false, error: String(error) });
    return true;
  }

  return false;
}
