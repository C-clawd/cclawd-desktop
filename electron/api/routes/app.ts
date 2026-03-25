import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody } from '../route-utils';
import { setCorsHeaders, sendJson, sendNoContent } from '../route-utils';
import { runOpenClawDoctor, runOpenClawDoctorFix } from '../../utils/openclaw-doctor';
import { readOpenClawEnv, writeOpenClawEnv, type OpenClawEnvEntry } from '../../utils/openclaw-env';
import {
  checkRealPersonAuth,
  ensureSetupRealPersonAuthConfig,
  startRealPersonAuth,
  startRealPersonAuthWithSavedApiKey,
} from '../../utils/real-person-auth';
import { getSetting, setSetting } from '../../utils/store';
import { ensureTrialStartAt } from '../../utils/trial';

async function buildPeriodicAuthState() {
  return {
    enabled: await getSetting('periodicAuthEnabled'),
    intervalMs: await getSetting('periodicAuthIntervalMs'),
    lastVerifiedAt: await getSetting('periodicAuthLastVerifiedAt'),
    locked: await getSetting('periodicAuthLocked'),
  };
}

async function markPeriodicAuthComplete() {
  await setSetting('periodicAuthLastVerifiedAt', Date.now());
  await setSetting('periodicAuthLocked', false);
}

export async function handleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    setCorsHeaders(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    ctx.eventBus.addSseClient(res);
    // Send a current-state snapshot immediately so renderer subscribers do not
    // miss lifecycle transitions that happened before the SSE connection opened.
    res.write(`event: gateway:status\ndata: ${JSON.stringify(ctx.gatewayManager.getStatus())}\n\n`);
    return true;
  }

  if (url.pathname === '/api/app/openclaw-doctor' && req.method === 'POST') {
    const body = await parseJsonBody<{ mode?: 'diagnose' | 'fix' }>(req);
    const mode = body.mode === 'fix' ? 'fix' : 'diagnose';
    sendJson(res, 200, mode === 'fix' ? await runOpenClawDoctorFix() : await runOpenClawDoctor());
    return true;
  }

  if (url.pathname === '/api/app/openclaw-env' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await readOpenClawEnv()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/openclaw-env' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ entries?: OpenClawEnvEntry[] }>(req);
      const entries = Array.isArray(body.entries) ? body.entries : [];
      sendJson(res, 200, { success: true, ...(await writeOpenClawEnv(entries)) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/real-person-auth/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ name?: string; idCard?: string }>(req);
      sendJson(res, 200, { success: true, ...(await startRealPersonAuth(body.name || '', body.idCard || '')) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/real-person-auth/check' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ apiKey?: string; certToken?: string; context?: 'setup' | 'periodic' }>(req);
      const result = await checkRealPersonAuth(body.apiKey || '', body.certToken || '');
      if (result.status === 'success') {
        await ensureTrialStartAt();
        if (body.context === 'setup') {
          await ensureSetupRealPersonAuthConfig();
        }
        await markPeriodicAuthComplete();
      }
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/real-person-auth/start-from-saved-key' && req.method === 'POST') {
    try {
      sendJson(res, 200, { success: true, ...(await startRealPersonAuthWithSavedApiKey()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/periodic-auth/state' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await buildPeriodicAuthState()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/periodic-auth/lock' && req.method === 'POST') {
    try {
      await setSetting('periodicAuthLocked', true);
      sendJson(res, 200, { success: true, ...(await buildPeriodicAuthState()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/app/periodic-auth/complete' && req.method === 'POST') {
    try {
      await markPeriodicAuthComplete();
      sendJson(res, 200, { success: true, ...(await buildPeriodicAuthState()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return true;
  }

  return false;
}
