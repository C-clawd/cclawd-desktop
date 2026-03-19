import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { proxyAwareFetch } from './proxy-fetch';
import { readOpenClawEnv, writeOpenClawEnv, type OpenClawEnvEntry } from './openclaw-env';
import { getOpenClawResolvedDir } from './paths';

const require = createRequire(import.meta.url);
const openclawRequire = createRequire(join(getOpenClawResolvedDir(), 'package.json'));
const qrcodeTerminalPath = dirname(openclawRequire.resolve('qrcode-terminal/package.json'));
const QRCode = require(join(qrcodeTerminalPath, 'vendor', 'QRCode', 'index.js'));
const QRErrorCorrectLevel = require(join(qrcodeTerminalPath, 'vendor', 'QRCode', 'QRErrorCorrectLevel.js'));

const REAL_PERSON_AUTH_BASE_URL = 'https://cclawd.dbhl.cn';
const MFA_AUTH_API_KEY = 'MFA_AUTH_API_KEY';
const REAL_PERSON_ENV_DEFAULTS: Array<OpenClawEnvEntry> = [
  { key: 'DABBY_API_BASE_URL', value: REAL_PERSON_AUTH_BASE_URL },
  { key: 'MFA_REQUIRE_AUTH_ON_FIRST_MESSAGE', value: 'true' },
  { key: 'MFA_FIRST_MESSAGE_AUTH_DURATION', value: '86400000' },
  { key: 'MFA_AUTH_STATE_DIR', value: '~/.openclaw/cclawd-mfa-auth/' },
  { key: 'MFA_REQUIRE_AUTH_ON_SENSITIVE_OPERATION', value: 'true' },
  { key: 'MFA_VERIFICATION_DURATION', value: '120001' },
  { key: 'MFA_SENSITIVE_KEYWORDS', value: 'delete,rm,remove,rmdir,del,unlink,drop,truncate,Remove-Item' },
];

type RealPersonApiResponse = {
  code?: number;
  retCode?: number;
  message?: string;
  msg?: string;
  data?: Record<string, unknown>;
};

export type RealPersonAuthStartResult = {
  apiKey: string;
  certToken: string;
  qrCodeUrl: string;
  qrCodeDataUrl: string;
};

export type RealPersonAuthCheckResult =
  | { status: 'pending'; message: string; retCode?: number }
  | { status: 'success'; message: string }
  | { status: 'failed'; message: string; retCode?: number };

function getResponseMessage(payload: RealPersonApiResponse, fallback: string): string {
  if (typeof payload.data?.message === 'string' && payload.data.message.trim()) {
    return payload.data.message;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  if (typeof payload.msg === 'string' && payload.msg.trim()) {
    return payload.msg;
  }
  return fallback;
}

async function parseJsonResponse(response: Response, fallbackMessage: string): Promise<RealPersonApiResponse> {
  let payload: RealPersonApiResponse = {};
  try {
    payload = await response.json() as RealPersonApiResponse;
  } catch {
    if (!response.ok) {
      throw new Error(`${fallbackMessage}: ${response.status} ${response.statusText}`);
    }
    return {};
  }

  if (!response.ok) {
    throw new Error(getResponseMessage(payload, `${fallbackMessage}: ${response.status} ${response.statusText}`));
  }

  return payload;
}

async function requestJson(
  input: string | URL,
  init: RequestInit | undefined,
  fallbackMessage: string,
): Promise<RealPersonApiResponse> {
  const response = await proxyAwareFetch(input, init);
  return await parseJsonResponse(response, fallbackMessage);
}

function createQrMatrix(input: string) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

function fillPixel(
  buf: Buffer,
  x: number,
  y: number,
  width: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) {
  const idx = (y * width + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buf: Buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer: Buffer, width: number, height: number) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderQrCodeDataUrl(input: string, scale = 6, marginModules = 4): string {
  const qr = createQrMatrix(input);
  const modules = qr.getModuleCount();
  const size = (modules + marginModules * 2) * scale;
  const buf = Buffer.alloc(size * size * 4, 255);

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) continue;
      const startX = (col + marginModules) * scale;
      const startY = (row + marginModules) * scale;
      for (let y = 0; y < scale; y += 1) {
        const pixelY = startY + y;
        for (let x = 0; x < scale; x += 1) {
          fillPixel(buf, startX + x, pixelY, size, 0, 0, 0, 255);
        }
      }
    }
  }

  const png = encodePngRgba(buf, size, size);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export async function startRealPersonAuth(name: string, idCard: string): Promise<RealPersonAuthStartResult> {
  const trimmedName = name.trim();
  const trimmedIdCard = idCard.trim();

  if (!trimmedName) {
    throw new Error('Name is required');
  }
  if (!trimmedIdCard) {
    throw new Error('ID card number is required');
  }

  const apiKeyUrl = new URL('/api/v1/getApiKey', REAL_PERSON_AUTH_BASE_URL);
  apiKeyUrl.searchParams.set('userId', trimmedName);
  apiKeyUrl.searchParams.set('idCard', trimmedIdCard);

  const apiKeyPayload = await requestJson(apiKeyUrl, undefined, 'Failed to request verification API key');
  const apiKey = typeof apiKeyPayload.data?.apiKey === 'string' ? apiKeyPayload.data.apiKey : '';
  if (!apiKey) {
    throw new Error(getResponseMessage(apiKeyPayload, 'Verification API key was missing from response'));
  }

  const verifyPayload = await requestJson(
    new URL('/api/v1/getVerifyCode', REAL_PERSON_AUTH_BASE_URL),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey,
        authType: 'ScanAuth',
        mode: '66',
      }),
    },
    'Failed to create verification QR code',
  );

  const certToken = typeof verifyPayload.data?.certToken === 'string' ? verifyPayload.data.certToken : '';
  const qrCodeUrl = typeof verifyPayload.data?.qrCodeUrl === 'string' ? verifyPayload.data.qrCodeUrl : '';
  if (!certToken || !qrCodeUrl) {
    throw new Error(getResponseMessage(verifyPayload, 'Verification QR code response was incomplete'));
  }

  return {
    apiKey,
    certToken,
    qrCodeUrl,
    qrCodeDataUrl: renderQrCodeDataUrl(qrCodeUrl),
  };
}

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

async function persistApiKeyToEnv(apiKey: string): Promise<void> {
  const current = await readOpenClawEnv();
  let nextEntries = upsertEnvEntry(current.entries, MFA_AUTH_API_KEY, apiKey);
  for (const entry of REAL_PERSON_ENV_DEFAULTS) {
    nextEntries = upsertEnvEntry(nextEntries, entry.key, entry.value);
  }
  await writeOpenClawEnv(nextEntries);
}

export async function checkRealPersonAuth(apiKey: string, certToken: string): Promise<RealPersonAuthCheckResult> {
  const payload = await requestJson(
    new URL('/api/v1/checkAuthStatus', REAL_PERSON_AUTH_BASE_URL),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, certToken }),
    },
    'Failed to check verification status',
  );

  const message = getResponseMessage(payload, 'Verification failed');
  const retCode = typeof payload.retCode === 'number' ? payload.retCode : undefined;
  const authSuccess = payload.data?.authSuccess === true;

  if (authSuccess) {
    await persistApiKeyToEnv(apiKey);
    return { status: 'success', message };
  }

  if (retCode === 4401) {
    return { status: 'pending', message, retCode };
  }

  return {
    status: 'failed',
    message,
    retCode,
  };
}
