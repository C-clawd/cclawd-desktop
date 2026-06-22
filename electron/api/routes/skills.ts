import type { IncomingMessage, ServerResponse } from 'http';
import type { ClawHubInstallParams, ClawHubSearchParams, ClawHubUninstallParams } from '../../gateway/clawhub';
import type { QoderSkillInstallParams, QoderSkillSearchParams, QoderSkillUninstallParams } from '../../gateway/qoder-skills';
import { getAllSkillConfigs, getBuiltinSkillDefinitions, getMainAgentPromptInjectedSkills, updateSkillConfig } from '../../utils/skill-config';
import { getRolePresetManifest, installRolePresetSkills } from '../../utils/skill-role-presets';
import { setSetting } from '../../utils/store';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseQoderSearchParams(body: Record<string, unknown>): QoderSkillSearchParams {
  return {
    query: optionalString(body.query),
    limit: optionalNumber(body.limit),
    category: optionalString(body.category),
    sort: optionalString(body.sort) === 'recent' ? 'recent' : 'hot',
  };
}

function parseQoderInstallParams(body: Record<string, unknown>): QoderSkillInstallParams {
  const slug = optionalString(body.slug);
  if (!slug) {
    throw new Error('Missing required field: slug');
  }
  return {
    slug,
    version: optionalString(body.version),
    force: optionalBoolean(body.force),
    skillId: optionalString(body.skillId),
    downloadUrl: optionalString(body.downloadUrl),
  };
}

function parseQoderUninstallParams(body: Record<string, unknown>): QoderSkillUninstallParams {
  const slug = optionalString(body.slug);
  if (!slug) {
    throw new Error('Missing required field: slug');
  }
  return { slug };
}

function parseClawHubSearchParams(body: Record<string, unknown>): ClawHubSearchParams {
  return {
    query: optionalString(body.query) || '',
    limit: optionalNumber(body.limit),
  };
}

function parseClawHubInstallParams(body: Record<string, unknown>): ClawHubInstallParams {
  const slug = optionalString(body.slug);
  if (!slug) {
    throw new Error('Missing required field: slug');
  }
  return {
    slug,
    version: optionalString(body.version),
    force: optionalBoolean(body.force),
  };
}

function parseClawHubUninstallParams(body: Record<string, unknown>): ClawHubUninstallParams {
  const slug = optionalString(body.slug);
  if (!slug) {
    throw new Error('Missing required field: slug');
  }
  return { slug };
}

function parseRolePresetInstallParams(body: Record<string, unknown>): { roleIds: string[]; includeBaseSkills?: boolean } {
  const roleIds = Array.isArray(body.roleIds)
    ? body.roleIds.filter((roleId): roleId is string => typeof roleId === 'string' && roleId.trim().length > 0)
    : [];
  return {
    roleIds,
    includeBaseSkills: optionalBoolean(body.includeBaseSkills),
  };
}

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/skills/configs' && req.method === 'GET') {
    sendJson(res, 200, await getAllSkillConfigs());
    return true;
  }

  if (url.pathname === '/api/skills/config' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{
        skillKey: string;
        apiKey?: string;
        env?: Record<string, string>;
      }>(req);
      sendJson(res, 200, await updateSkillConfig(body.skillKey, {
        apiKey: body.apiKey,
        env: body.env,
      }));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/builtin' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await getBuiltinSkillDefinitions() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/prompt-injected' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await getMainAgentPromptInjectedSkills() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/role-presets' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, ...(await getRolePresetManifest()) });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/skills/install-role-preset' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      const result = await installRolePresetSkills(ctx.qoderSkillService, parseRolePresetInstallParams(body));
      await setSetting('userRoleTags', result.roleIds);
      await setSetting('installedRolePresetVersion', result.version);
      await setSetting('installedRolePresetAt', Date.now());
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/search' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      sendJson(res, 200, {
        success: true,
        results: await ctx.qoderSkillService.search(parseQoderSearchParams(body)),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.qoderSkillService.install(parseQoderInstallParams(body));
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/uninstall' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.qoderSkillService.uninstall(parseQoderUninstallParams(body));
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/list' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await ctx.qoderSkillService.listInstalled() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/open-readme' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.qoderSkillService.openSkillReadme(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/qoder-skills/open-path' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.qoderSkillService.openSkillPath(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/search' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      sendJson(res, 200, {
        success: true,
        results: await ctx.clawHubService.search(parseClawHubSearchParams(body)),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.clawHubService.install(parseClawHubInstallParams(body));
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/uninstall' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      await ctx.clawHubService.uninstall(parseClawHubUninstallParams(body));
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/list' && req.method === 'GET') {
    try {
      sendJson(res, 200, { success: true, results: await ctx.clawHubService.listInstalled() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/open-readme' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.clawHubService.openSkillReadme(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/clawhub/open-path' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ slug?: string; skillKey?: string; baseDir?: string }>(req);
      await ctx.clawHubService.openSkillPath(body.skillKey || body.slug || '', body.slug, body.baseDir);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
