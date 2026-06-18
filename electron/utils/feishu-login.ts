import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { renderQrPngDataUrl } from './qr-image';
import { resolveOpenClawRuntimeModulePath } from './runtime-package-resolution';

const require = createRequire(import.meta.url);

const DEFAULT_SOURCE = 'openClaw';
// The device-authorization QR link is short-lived (a few minutes). Keep a
// generous local TTL so a freshly generated QR can be reused before expiry.
const SESSION_TTL_MS = 10 * 60_000;

type RegisterAppQRInfo = {
  url: string;
  expireIn?: number;
};

type RegisterAppStatusInfo = {
  status: string;
  interval?: number;
};

type RegisterAppResult = {
  client_id: string;
  client_secret: string;
  user_info?: {
    open_id?: string;
    tenant_brand?: 'feishu' | 'lark';
  };
};

type RegisterAppOptions = {
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady(info: RegisterAppQRInfo): void;
  onStatusChange?(info: RegisterAppStatusInfo): void;
};

type LarkSdk = {
  registerApp(options: RegisterAppOptions): Promise<RegisterAppResult>;
};

let larkSdk: LarkSdk | null = null;

function getLarkSdk(): LarkSdk {
  if (larkSdk) {
    return larkSdk;
  }
  const modulePath = resolveOpenClawRuntimeModulePath('@larksuiteoapi/node-sdk');
  larkSdk = require(modulePath) as LarkSdk;
  return larkSdk;
}

type ActiveLogin = {
  sessionKey: string;
  controller: AbortController;
  qrcodeUrl: string;
  registerPromise: Promise<RegisterAppResult>;
  startedAt: number;
  settled: boolean;
};

export type FeishuLoginStartResult = {
  sessionKey: string;
  qrcodeUrl?: string;
  verificationUri?: string;
  message: string;
};

export type FeishuLoginWaitResult = {
  connected: boolean;
  message: string;
  appId?: string;
  appSecret?: string;
};

const activeLogins = new Map<string, ActiveLogin>();

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < SESSION_TTL_MS;
}

export async function startFeishuLoginSession(options: {
  sessionKey?: string;
  source?: string;
  force?: boolean;
}): Promise<FeishuLoginStartResult> {
  const sessionKey = options.sessionKey?.trim() || randomUUID();
  const source = options.source?.trim() || DEFAULT_SOURCE;

  const existing = activeLogins.get(sessionKey);
  if (!options.force && existing && isLoginFresh(existing) && existing.qrcodeUrl && !existing.settled) {
    return {
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: 'QR code is ready. Scan it with Feishu/Lark.',
    };
  }

  if (existing) {
    existing.controller.abort();
    activeLogins.delete(sessionKey);
  }

  const sdk = getLarkSdk();
  const controller = new AbortController();

  let resolveQr!: (value: { url: string }) => void;
  let rejectQr!: (reason: unknown) => void;
  const qrReady = new Promise<{ url: string }>((resolve, reject) => {
    resolveQr = resolve;
    rejectQr = reject;
  });

  // registerApp drives the entire OAuth Device Authorization Grant internally.
  // The QR URL is delivered through onQRCodeReady during the promise; the
  // promise resolves with credentials on success and rejects on error/cancel.
  const registerPromise = sdk.registerApp({
    source,
    signal: controller.signal,
    onQRCodeReady(info) {
      if (info?.url) {
        resolveQr({ url: info.url });
      }
    },
  });

  // If registerApp rejects before a QR is ready, surface it to the start waiter.
  // (Rejecting an already-resolved qrReady promise is a harmless no-op.)
  registerPromise.catch((error) => {
    rejectQr(error);
  });

  const login: ActiveLogin = {
    sessionKey,
    controller,
    qrcodeUrl: '',
    registerPromise,
    startedAt: Date.now(),
    settled: false,
  };
  registerPromise
    .finally(() => {
      login.settled = true;
    })
    .catch(() => { });
  activeLogins.set(sessionKey, login);

  const { url } = await qrReady;
  const qrcodeUrl = await renderQrPngDataUrl(url);
  login.qrcodeUrl = qrcodeUrl;

  return {
    sessionKey,
    qrcodeUrl,
    verificationUri: url,
    message: 'Scan the QR code with Feishu/Lark to authorize and create the application.',
  };
}

export async function waitForFeishuLoginSession(options: {
  sessionKey: string;
  timeoutMs?: number;
}): Promise<FeishuLoginWaitResult> {
  const login = activeLogins.get(options.sessionKey);
  if (!login) {
    return {
      connected: false,
      message: 'No active Feishu login session. Generate a new QR code and try again.',
    };
  }

  const timeoutMs = Math.max(options.timeoutMs ?? SESSION_TTL_MS, 1000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<FeishuLoginWaitResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({ connected: false, message: 'Timed out waiting for Feishu authorization.' });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      login.registerPromise.then(
        (value): FeishuLoginWaitResult => {
          if (!value?.client_id || !value?.client_secret) {
            return {
              connected: false,
              message: 'Feishu authorization succeeded but did not return application credentials.',
            };
          }
          return {
            connected: true,
            appId: value.client_id,
            appSecret: value.client_secret,
            message: 'Feishu application created successfully.',
          };
        },
        (error): FeishuLoginWaitResult => {
          const code = (error as { code?: string })?.code;
          const description = (error as { description?: string })?.description;
          if (code === 'abort') {
            return { connected: false, message: 'The Feishu login session was cancelled.' };
          }
          if (code === 'expired_token') {
            return {
              connected: false,
              message: 'The QR code has expired. Generate a new QR code and try again.',
            };
          }
          if (code === 'access_denied') {
            return { connected: false, message: 'Feishu authorization was denied.' };
          }
          return {
            connected: false,
            message: description || (error instanceof Error ? error.message : String(error)) || 'Feishu authorization failed.',
          };
        },
      ),
      timeoutPromise,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    const current = activeLogins.get(options.sessionKey);
    if (current === login) {
      login.controller.abort();
      activeLogins.delete(options.sessionKey);
    }
  }
}

export async function cancelFeishuLoginSession(sessionKey?: string): Promise<void> {
  if (!sessionKey) {
    for (const login of activeLogins.values()) {
      login.controller.abort();
    }
    activeLogins.clear();
    return;
  }
  const login = activeLogins.get(sessionKey);
  if (login) {
    login.controller.abort();
    activeLogins.delete(sessionKey);
  }
}
