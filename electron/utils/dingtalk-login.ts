import { randomUUID } from 'node:crypto';
import { renderQrPngDataUrl } from './qr-image';

export const DEFAULT_DINGTALK_BASE_URL = 'https://oapi.dingtalk.com';
const DEFAULT_SOURCE = 'openClaw';
// device_code is nominally valid for 7200s, but user_code/device_code expire in ~10 minutes per docs.
const DEVICE_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const POLL_REQUEST_TIMEOUT_MS = 15_000;

type InitResponse = {
  errcode: number;
  errmsg?: string;
  nonce?: string;
  expires_in?: number;
};

type BeginResponse = {
  errcode: number;
  errmsg?: string;
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

type PollResponse = {
  errcode: number;
  errmsg?: string;
  status?: 'WAITING' | 'SUCCESS' | 'FAIL' | 'EXPIRED';
  client_id?: string;
  client_secret?: string;
  fail_reason?: string;
};

type ActiveLogin = {
  sessionKey: string;
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  qrcodeUrl: string;
  apiBaseUrl: string;
  intervalMs: number;
  startedAt: number;
};

export type DingTalkLoginStartResult = {
  sessionKey: string;
  qrcodeUrl?: string;
  userCode?: string;
  verificationUri?: string;
  message: string;
};

export type DingTalkLoginWaitResult = {
  connected: boolean;
  message: string;
  clientId?: string;
  clientSecret?: string;
};

const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < DEVICE_CODE_TTL_MS;
}

async function postJson<T>(apiBaseUrl: string, path: string, body: unknown, timeoutMs?: number): Promise<T> {
  const base = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const url = `${base}${path}`;
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`DingTalk ${path} failed: ${response.status} ${response.statusText} ${rawText}`);
    }
    return JSON.parse(rawText) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertOk(response: { errcode: number; errmsg?: string }, path: string): void {
  if (response.errcode !== 0) {
    throw new Error(`DingTalk ${path} error (${response.errcode}): ${response.errmsg || 'unknown error'}`);
  }
}

export async function startDingTalkLoginSession(options: {
  sessionKey?: string;
  apiBaseUrl?: string;
  source?: string;
  force?: boolean;
}): Promise<DingTalkLoginStartResult> {
  const sessionKey = options.sessionKey?.trim() || randomUUID();
  const apiBaseUrl = options.apiBaseUrl?.trim() || DEFAULT_DINGTALK_BASE_URL;
  const source = options.source?.trim() || DEFAULT_SOURCE;

  const existing = activeLogins.get(sessionKey);
  if (!options.force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      userCode: existing.userCode,
      verificationUri: existing.verificationUriComplete,
      message: 'QR code is ready. Scan it with DingTalk.',
    };
  }

  const initResponse = await postJson<InitResponse>(
    apiBaseUrl,
    '/app/registration/init',
    source ? { source } : {},
  );
  assertOk(initResponse, '/app/registration/init');
  if (!initResponse.nonce) {
    throw new Error('DingTalk init did not return a nonce.');
  }

  const beginResponse = await postJson<BeginResponse>(
    apiBaseUrl,
    '/app/registration/begin',
    { nonce: initResponse.nonce },
  );
  assertOk(beginResponse, '/app/registration/begin');
  if (!beginResponse.device_code || !beginResponse.verification_uri_complete) {
    throw new Error('DingTalk begin did not return device_code or verification_uri_complete.');
  }

  const qrcodeUrl = await renderQrPngDataUrl(beginResponse.verification_uri_complete);
  const intervalMs = beginResponse.interval && beginResponse.interval > 0
    ? beginResponse.interval * 1000
    : DEFAULT_POLL_INTERVAL_MS;

  activeLogins.set(sessionKey, {
    sessionKey,
    deviceCode: beginResponse.device_code,
    userCode: beginResponse.user_code || '',
    verificationUriComplete: beginResponse.verification_uri_complete,
    qrcodeUrl,
    apiBaseUrl,
    intervalMs,
    startedAt: Date.now(),
  });

  return {
    sessionKey,
    qrcodeUrl,
    userCode: beginResponse.user_code,
    verificationUri: beginResponse.verification_uri_complete,
    message: 'Scan the QR code with DingTalk to authorize and create the application.',
  };
}

export async function waitForDingTalkLoginSession(options: {
  sessionKey: string;
  timeoutMs?: number;
}): Promise<DingTalkLoginWaitResult> {
  const login = activeLogins.get(options.sessionKey);
  if (!login) {
    return {
      connected: false,
      message: 'No active DingTalk login session. Generate a new QR code and try again.',
    };
  }

  if (!isLoginFresh(login)) {
    activeLogins.delete(options.sessionKey);
    return {
      connected: false,
      message: 'The QR code has expired. Generate a new QR code and try again.',
    };
  }

  const timeoutMs = Math.max(options.timeoutMs ?? DEVICE_CODE_TTL_MS, 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = activeLogins.get(options.sessionKey);
    if (!current) {
      return {
        connected: false,
        message: 'The DingTalk login session was cancelled.',
      };
    }

    let pollResponse: PollResponse;
    try {
      pollResponse = await postJson<PollResponse>(
        current.apiBaseUrl,
        '/app/registration/poll',
        { device_code: current.deviceCode },
        POLL_REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        await new Promise((resolve) => setTimeout(resolve, current.intervalMs));
        continue;
      }
      throw error;
    }

    assertOk(pollResponse, '/app/registration/poll');

    switch (pollResponse.status) {
      case 'WAITING':
        break;
      case 'SUCCESS':
        activeLogins.delete(options.sessionKey);
        if (!pollResponse.client_id || !pollResponse.client_secret) {
          return {
            connected: false,
            message: 'DingTalk authorization succeeded but did not return application credentials.',
          };
        }
        return {
          connected: true,
          clientId: pollResponse.client_id,
          clientSecret: pollResponse.client_secret,
          message: 'DingTalk application created successfully.',
        };
      case 'FAIL':
        activeLogins.delete(options.sessionKey);
        return {
          connected: false,
          message: pollResponse.fail_reason || 'DingTalk authorization failed.',
        };
      case 'EXPIRED':
        activeLogins.delete(options.sessionKey);
        return {
          connected: false,
          message: 'The QR code has expired. Generate a new QR code and try again.',
        };
      default:
        break;
    }

    await new Promise((resolve) => setTimeout(resolve, current.intervalMs));
  }

  activeLogins.delete(options.sessionKey);
  return {
    connected: false,
    message: 'Timed out waiting for DingTalk authorization.',
  };
}

export async function cancelDingTalkLoginSession(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    activeLogins.clear();
    return;
  }
  activeLogins.delete(sessionKey);
}
