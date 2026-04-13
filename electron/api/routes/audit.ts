import type { IncomingMessage, ServerResponse } from 'http';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import type { HostApiContext } from '../context';
import { sendJson } from '../route-utils';

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
  coreUrl?: string;
};

const DEFAULT_GUARD_BASE_URL = 'http://127.0.0.1:53666/cclawd-guard-core';
const GUARD_BASE_URL = (process.env.CCLAWD_GUARD_BASE_URL || DEFAULT_GUARD_BASE_URL).replace(/\/$/, '');
const SHARED_CREDENTIALS_FILE = path.join(
  os.homedir(),
  '.openclaw',
  'credentials',
  'cclawd-guard',
  'credentials.json',
);

let cachedGuardAgentId = '';
let cachedGuardApiKey = '';
let cachedMachineId = '';

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

function loadSharedGuardCredentials(): { agentId: string; apiKey: string } | null {
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
    return { agentId, apiKey };
  } catch {
    return null;
  }
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

async function ensureGuardAuth(): Promise<{ agentId: string; apiKey: string }> {
  if (cachedGuardAgentId && cachedGuardApiKey) {
    return { agentId: cachedGuardAgentId, apiKey: cachedGuardApiKey };
  }

  const sharedCredentials = loadSharedGuardCredentials();
  if (sharedCredentials && await isValidGuardApiKey(sharedCredentials.apiKey)) {
    cachedGuardAgentId = sharedCredentials.agentId;
    cachedGuardApiKey = sharedCredentials.apiKey;
    return sharedCredentials;
  }

  const registerResponse = await proxyAwareFetch(`${GUARD_BASE_URL}/api/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'cclawd-desktop',
      description: 'Desktop audit dashboard access',
    }),
  });

  const payload = await parseGuardJson<GuardRegisterResponse>(registerResponse);
  const agentId = payload?.agent?.id ?? '';
  const apiKey = payload?.agent?.api_key ?? '';

  if (!registerResponse.ok || !payload?.success || !agentId || !apiKey) {
    throw new Error(`Failed to register guard agent: HTTP ${registerResponse.status}`);
  }

  cachedGuardAgentId = agentId;
  cachedGuardApiKey = apiKey;
  return { agentId, apiKey };
}

async function getCurrentMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;

  const hostname = os.hostname();
  const interfaces = os.networkInterfaces();
  let mac = '';

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        mac = info.mac;
        break;
      }
    }
    if (mac) break;
  }

  const input = `${hostname}:${mac || 'unknown'}`;
  const generatedMachineId = createHash('sha256').update(input).digest('hex').slice(0, 16);
  cachedMachineId = generatedMachineId;
  return cachedMachineId;
}

async function withDefaultMachineId(upstreamPathWithQuery: string): Promise<string> {
  const requestUrl = new URL(upstreamPathWithQuery, GUARD_BASE_URL);
  if (!requestUrl.searchParams.get('machineId')) {
    requestUrl.searchParams.set('machineId', await getCurrentMachineId());
  }
  return `${requestUrl.pathname}${requestUrl.search}`;
}

async function proxyGuardGet(
  req: IncomingMessage,
  res: ServerResponse,
  upstreamPathWithQuery: string,
): Promise<void> {
  const auth = await ensureGuardAuth();
  const upstream = await withDefaultMachineId(upstreamPathWithQuery);
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
  if (req.method !== 'GET') {
    return false;
  }

  try {
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
