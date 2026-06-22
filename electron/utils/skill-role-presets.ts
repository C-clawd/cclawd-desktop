import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import type { QoderSkillService } from '../gateway/qoder-skills';
import { getOpenClawConfigDir, getResourcesDir } from './paths';
import { setSkillsEnabled } from './skill-config';
import { logger } from './logger';

export type RolePresetSkillSource = 'builtin' | 'qoder';

export interface RolePresetSkill {
    slug: string;
    source: RolePresetSkillSource;
    name: string;
    nameZh: string;
    description?: string;
    descriptionZh?: string;
    autoEnable?: boolean;
}

export interface RolePreset {
    id: string;
    name: string;
    nameZh: string;
    description: string;
    descriptionZh: string;
    workflows?: string[];
    skills: RolePresetSkill[];
}

export interface RolePresetManifest {
    version: number;
    baseSkills: RolePresetSkill[];
    roles: RolePreset[];
}

export interface RolePresetInstallParams {
    roleIds: string[];
    includeBaseSkills?: boolean;
}

export interface RolePresetInstallResult {
    success: boolean;
    version: number;
    roleIds: string[];
    installed: string[];
    enabled: string[];
    skipped: string[];
    failed: Array<{ slug: string; error: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    return value.map(asString).filter(Boolean);
}

function asSource(value: unknown): RolePresetSkillSource | null {
    const source = asString(value);
    return source === 'builtin' || source === 'qoder' ? source : null;
}

function parseSkill(value: unknown): RolePresetSkill | null {
    if (!isRecord(value)) return null;
    const slug = asString(value.slug);
    const source = asSource(value.source);
    const name = asString(value.name);
    const nameZh = asString(value.nameZh);
    if (!slug || !source || !name || !nameZh) return null;
    return {
        slug,
        source,
        name,
        nameZh,
        description: asString(value.description) || undefined,
        descriptionZh: asString(value.descriptionZh) || undefined,
        autoEnable: typeof value.autoEnable === 'boolean' ? value.autoEnable : true,
    };
}

function parseRole(value: unknown): RolePreset | null {
    if (!isRecord(value)) return null;
    const id = asString(value.id);
    const name = asString(value.name);
    const nameZh = asString(value.nameZh);
    const description = asString(value.description);
    const descriptionZh = asString(value.descriptionZh);
    const skills = Array.isArray(value.skills)
        ? value.skills.map(parseSkill).filter((skill): skill is RolePresetSkill => Boolean(skill))
        : [];
    if (!id || !name || !nameZh || !description || !descriptionZh || skills.length === 0) return null;
    return {
        id,
        name,
        nameZh,
        description,
        descriptionZh,
        workflows: asStringArray(value.workflows),
        skills,
    };
}

function parseManifest(raw: unknown): RolePresetManifest {
    if (!isRecord(raw)) {
        throw new Error('Invalid role preset manifest');
    }
    const version = typeof raw.version === 'number' && Number.isFinite(raw.version)
        ? Math.max(1, Math.floor(raw.version))
        : 1;
    const baseSkills = Array.isArray(raw.baseSkills)
        ? raw.baseSkills.map(parseSkill).filter((skill): skill is RolePresetSkill => Boolean(skill))
        : [];
    const roles = Array.isArray(raw.roles)
        ? raw.roles.map(parseRole).filter((role): role is RolePreset => Boolean(role))
        : [];
    if (roles.length === 0) {
        throw new Error('Role preset manifest does not contain roles');
    }
    return { version, baseSkills, roles };
}

function resolveRolePresetManifestPath(): string | null {
    const candidates = [
        join(getResourcesDir(), 'skills', 'role-presets.json'),
        join(process.cwd(), 'resources', 'skills', 'role-presets.json'),
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function getRolePresetManifest(): Promise<RolePresetManifest> {
    const manifestPath = resolveRolePresetManifestPath();
    if (!manifestPath) {
        throw new Error('Role preset manifest not found');
    }
    const raw = await readFile(manifestPath, 'utf-8');
    return parseManifest(JSON.parse(raw) as unknown);
}

export function buildRolePresetInstallPlan(
    manifest: RolePresetManifest,
    params: RolePresetInstallParams,
): { roleIds: string[]; skills: RolePresetSkill[] } {
    const selectedRoleIds = Array.from(new Set(params.roleIds.map((roleId) => roleId.trim()).filter(Boolean)));
    const roleIds = selectedRoleIds.length > 0 ? selectedRoleIds : ['general-office'];
    const rolesById = new Map(manifest.roles.map((role) => [role.id, role]));
    const missingRoleIds = roleIds.filter((roleId) => !rolesById.has(roleId));
    if (missingRoleIds.length > 0) {
        throw new Error(`Unknown role preset: ${missingRoleIds.join(', ')}`);
    }

    const skillsBySlug = new Map<string, RolePresetSkill>();
    if (params.includeBaseSkills !== false) {
        for (const skill of manifest.baseSkills) {
            skillsBySlug.set(skill.slug, skill);
        }
    }
    for (const roleId of roleIds) {
        for (const skill of rolesById.get(roleId)?.skills || []) {
            skillsBySlug.set(skill.slug, skill);
        }
    }
    return { roleIds, skills: Array.from(skillsBySlug.values()) };
}

function getInstalledQoderSlugs(installed: Awaited<ReturnType<QoderSkillService['listInstalled']>>): Set<string> {
    return new Set(installed.map((skill) => skill.slug));
}

export async function installRolePresetSkills(
    qoderSkillService: QoderSkillService,
    params: RolePresetInstallParams,
): Promise<RolePresetInstallResult> {
    const manifest = await getRolePresetManifest();
    const plan = buildRolePresetInstallPlan(manifest, params);
    const installed: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ slug: string; error: string }> = [];
    const qoderSkills = plan.skills.filter((skill) => skill.source === 'qoder');
    let installedQoderSlugs = new Set<string>();
    try {
        installedQoderSlugs = getInstalledQoderSlugs(await qoderSkillService.listInstalled());
    } catch (error) {
        logger.warn('Failed to list installed Qoder skills before role preset install:', error);
    }

    for (const skill of qoderSkills) {
        if (installedQoderSlugs.has(skill.slug)) {
            skipped.push(skill.slug);
            continue;
        }
        try {
            await qoderSkillService.install({ slug: skill.slug });
            installed.push(skill.slug);
            installedQoderSlugs.add(skill.slug);
        } catch (error) {
            failed.push({ slug: skill.slug, error: String(error) });
            logger.warn(`Failed to install role preset skill ${skill.slug}:`, error);
        }
    }

    const failedSlugs = new Set(failed.map((item) => item.slug));
    const enabledUnique = Array.from(new Set(
        plan.skills
            .filter((skill) => skill.autoEnable !== false)
            .filter((skill) => skill.source === 'builtin' || !failedSlugs.has(skill.slug))
            .map((skill) => skill.slug),
    ));
    try {
        await setSkillsEnabled(enabledUnique, true);
    } catch (error) {
        logger.warn('Failed to enable role preset skills:', error);
        for (const slug of enabledUnique) {
            if (!failed.some((item) => item.slug === slug)) {
                failed.push({ slug, error: `Enable failed: ${String(error)}` });
            }
        }
    }

    return {
        success: failed.length === 0,
        version: manifest.version,
        roleIds: plan.roleIds,
        installed,
        enabled: enabledUnique,
        skipped,
        failed,
    };
}

export function getRolePresetInstallRoot(): string {
    return join(getOpenClawConfigDir(), 'skills');
}
