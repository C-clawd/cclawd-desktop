import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeOpenClawAccountId } from './channel-alias';
import { renderQrPngDataUrl } from './qr-image';

export const DEFAULT_WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_ILINK_BOT_TYPE = '3';
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;
const OPENCLAW_DIR = join(homedir(), '.openclaw');
const WECHAT_STATE_DIR = join(OPENCLAW_DIR, 'openclaw-weixin');
const WECHAT_ACCOUNT_INDEX_FILE = join(WECHAT_STATE_DIR, 'accounts.json');
const WECHAT_ACCOUNTS_DIR = join(WECHAT_STATE_DIR, 'accounts');

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  apiBaseUrl: string;
};

type QrCodeResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

type QrStatusResponse = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
};

export type WeChatLoginStartResult = {
  sessionKey: string;
  qrcodeUrl?: string;
  message: string;
};

export type WeChatLoginWaitResult = {
  connected: boolean;
  message: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
};

const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG?.trim();
  if (envPath) return envPath;
  return join(OPENCLAW_DIR, 'openclaw.json');
}

function loadWeChatRouteTag(accountId?: string): string | undefined {
  try {
    const configPath = resolveConfigPath();
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      channels?: Record<string, {
        routeTag?: string | number;
        accounts?: Record<string, { routeTag?: string | number }>;
      }>;
    };
    const section = parsed.channels?.['openclaw-weixin'];
    if (!section) return undefined;
    if (accountId) {
      const normalizedAccountId = normalizeOpenClawAccountId(accountId);
      const scopedRouteTag = section.accounts?.[normalizedAccountId]?.routeTag;
      if (typeof scopedRouteTag === 'number') return String(scopedRouteTag);
      if (typeof scopedRouteTag === 'string' && scopedRouteTag.trim()) return scopedRouteTag.trim();
    }
    if (typeof section.routeTag === 'number') return String(section.routeTag);
    if (typeof section.routeTag === 'string' && section.routeTag.trim()) return section.routeTag.trim();
  } catch {
    return undefined;
  }
  return undefined;
}

async function fetchWeChatQrCode(apiBaseUrl: string, accountId?: string, botType = DEFAULT_ILINK_BOT_TYPE): Promise<QrCodeResponse> {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const headers: Record<string, string> = {};
  const routeTag = loadWeChatRouteTag(accountId);
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }

  const response = await fetch(url.toString(), { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`Failed to fetch QR code: ${response.status} ${response.statusText} ${body}`);
  }
  return await response.json() as QrCodeResponse;
}

async function pollWeChatQrStatus(apiBaseUrl: string, qrcode: string, accountId?: string): Promise<QrStatusResponse> {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const headers: Record<string, string> = {
    'iLink-App-ClientVersion': '1',
  };
  const routeTag = loadWeChatRouteTag(accountId);
  if (routeTag) {
    headers.SKRouteTag = routeTag;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), { headers, signal: controller.signal });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`Failed to poll QR status: ${response.status} ${response.statusText} ${rawText}`);
    }
    return JSON.parse(rawText) as QrStatusResponse;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw error;
  }
}

async function readAccountIndex(): Promise<string[]> {
  try {
    const raw = await readFile(WECHAT_ACCOUNT_INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  } catch {
    return [];
  }
}

async function writeAccountIndex(accountIds: string[]): Promise<void> {
  await mkdir(WECHAT_STATE_DIR, { recursive: true });
  await writeFile(WECHAT_ACCOUNT_INDEX_FILE, JSON.stringify(accountIds, null, 2), 'utf-8');
}

export async function saveWeChatAccountState(rawAccountId: string, payload: {
  token: string;
  baseUrl?: string;
  userId?: string;
}): Promise<string> {
  const accountId = normalizeOpenClawAccountId(rawAccountId);
  await mkdir(WECHAT_ACCOUNTS_DIR, { recursive: true });

  const filePath = join(WECHAT_ACCOUNTS_DIR, `${accountId}.json`);
  const data = {
    token: payload.token.trim(),
    savedAt: new Date().toISOString(),
    ...(payload.baseUrl?.trim() ? { baseUrl: payload.baseUrl.trim() } : {}),
    ...(payload.userId?.trim() ? { userId: payload.userId.trim() } : {}),
  };
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  try {
    await chmod(filePath, 0o600);
  } catch {
    // best effort only
  }

  const existingAccountIds = await readAccountIndex();
  if (!existingAccountIds.includes(accountId)) {
    await writeAccountIndex([...existingAccountIds, accountId]);
  }

  return accountId;
}

export async function startWeChatLoginSession(options: {
  sessionKey?: string;
  accountId?: string;
  apiBaseUrl?: string;
  force?: boolean;
}): Promise<WeChatLoginStartResult> {
  const sessionKey = options.sessionKey?.trim() || randomUUID();
  const apiBaseUrl = options.apiBaseUrl?.trim() || DEFAULT_WECHAT_BASE_URL;
  const existing = activeLogins.get(sessionKey);

  if (!options.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: 'QR code is ready. Scan it with WeChat.',
    };
  }

  const qrResponse = await fetchWeChatQrCode(apiBaseUrl, options.accountId);
  const qrDataUrl = await renderQrPngDataUrl(qrResponse.qrcode_img_content);
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qrResponse.qrcode,
    qrcodeUrl: qrDataUrl,
    startedAt: Date.now(),
    apiBaseUrl,
  });

  return {
    sessionKey,
    qrcodeUrl: qrDataUrl,
    message: 'Scan the QR code with WeChat to complete login.',
  };
}

export async function waitForWeChatLoginSession(options: {
  sessionKey: string;
  timeoutMs?: number;
  accountId?: string;
  onQrRefresh?: (payload: { qrcodeUrl: string }) => void | Promise<void>;
}): Promise<WeChatLoginWaitResult> {
  const login = activeLogins.get(options.sessionKey);
  if (!login) {
    return {
      connected: false,
      message: 'No active WeChat login session. Generate a new QR code and try again.',
    };
  }

  if (!isLoginFresh(login)) {
    activeLogins.delete(options.sessionKey);
    return {
      connected: false,
      message: 'The QR code has expired. Generate a new QR code and try again.',
    };
  }

  const timeoutMs = Math.max(options.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;
  let qrRefreshCount = 1;

  while (Date.now() < deadline) {
    const current = activeLogins.get(options.sessionKey);
    if (!current) {
      return {
        connected: false,
        message: 'The WeChat login session was cancelled.',
      };
    }

    const statusResponse = await pollWeChatQrStatus(current.apiBaseUrl, current.qrcode, options.accountId);
    switch (statusResponse.status) {
      case 'wait':
      case 'scaned':
        break;
      case 'expired': {
        qrRefreshCount += 1;
        if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
          activeLogins.delete(options.sessionKey);
          return {
            connected: false,
            message: 'The QR code expired too many times. Generate a new QR code and try again.',
          };
        }
        const refreshedQr = await fetchWeChatQrCode(current.apiBaseUrl, options.accountId);
        const refreshedQrDataUrl = await renderQrPngDataUrl(refreshedQr.qrcode_img_content);
        activeLogins.set(options.sessionKey, {
          ...current,
          qrcode: refreshedQr.qrcode,
          qrcodeUrl: refreshedQrDataUrl,
          startedAt: Date.now(),
        });
        await options.onQrRefresh?.({ qrcodeUrl: refreshedQrDataUrl });
        break;
      }
      case 'confirmed':
        activeLogins.delete(options.sessionKey);
        if (!statusResponse.ilink_bot_id || !statusResponse.bot_token) {
          return {
            connected: false,
            message: 'WeChat login succeeded but the server did not return the required account credentials.',
          };
        }
        return {
          connected: true,
          botToken: statusResponse.bot_token,
          accountId: statusResponse.ilink_bot_id,
          baseUrl: statusResponse.baseurl,
          userId: statusResponse.ilink_user_id,
          message: 'WeChat connected successfully.',
        };
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  activeLogins.delete(options.sessionKey);
  return {
    connected: false,
    message: 'Timed out waiting for WeChat QR confirmation.',
  };
}

export async function cancelWeChatLoginSession(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    activeLogins.clear();
    return;
  }
  activeLogins.delete(sessionKey);
}

export async function clearWeChatLoginState(): Promise<void> {
  activeLogins.clear();
  await rm(WECHAT_STATE_DIR, { recursive: true, force: true });
}
