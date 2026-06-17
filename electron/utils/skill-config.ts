/**
 * Skill Config Utilities
 * Direct read/write access to skill configuration in ~/.openclaw/openclaw.json
 * This bypasses the Gateway RPC for faster and more reliable config updates.
 *
 * All file I/O uses async fs/promises to avoid blocking the main thread.
 */
import { readFile, access, cp, mkdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getOpenClawDir, getResourcesDir } from './paths';
import { logger } from './logger';
import { withConfigLock } from './config-mutex';
import { readJsonFileAllowMissing, writeJsonFileAtomic } from './openclaw-config-io';

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

interface SkillEntry {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
}

interface OpenClawConfig {
    skills?: {
        entries?: Record<string, SkillEntry>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface PreinstalledSkillSpec {
    slug: string;
    version?: string;
    autoEnable?: boolean;
}

interface PreinstalledManifest {
    skills?: PreinstalledSkillSpec[];
}

interface PreinstalledLockEntry {
    slug: string;
    version?: string;
}

interface PreinstalledLockFile {
    skills?: PreinstalledLockEntry[];
}

interface PreinstalledMarker {
    source: 'Cclawd-preinstalled';
    slug: string;
    version: string;
    installedAt: string;
}

interface BuiltinSkillSpec {
    slug: string;
    name: string;
    description: string;
    icon?: string;
    version?: string;
    autoEnable?: boolean;
    useButton?: boolean;
}

interface BuiltinManifest {
    skills?: BuiltinSkillSpec[];
}

interface BuiltinMarker {
    source: 'cclawd-builtin';
    slug: string;
    version: string;
    installedAt: string;
}

interface PromptInjectedSkill {
    name: string;
    description?: string;
    source?: string;
    baseDir?: string;
    filePath?: string;
}

interface SessionRecord {
    updatedAt?: number;
    skillsSnapshot?: {
        resolvedSkills?: PromptInjectedSkill[];
    };
}

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Read the current OpenClaw config
 */
async function readConfig(): Promise<OpenClawConfig> {
    try {
        return (await readJsonFileAllowMissing<OpenClawConfig>(OPENCLAW_CONFIG_PATH)) ?? {};
    } catch (err) {
        console.error('Failed to read openclaw config:', err);
        throw err;
    }
}

/**
 * Write the OpenClaw config
 */
async function writeConfig(config: OpenClawConfig): Promise<void> {
    await writeJsonFileAtomic(OPENCLAW_CONFIG_PATH, config);
}

async function setSkillsEnabled(skillKeys: string[], enabled: boolean): Promise<void> {
    if (skillKeys.length === 0) {
        return;
    }
    return withConfigLock(async () => {
        const config = await readConfig();
        if (!config.skills) {
            config.skills = {};
        }
        if (!config.skills.entries) {
            config.skills.entries = {};
        }
        for (const skillKey of skillKeys) {
            const entry = config.skills.entries[skillKey] || {};
            entry.enabled = enabled;
            config.skills.entries[skillKey] = entry;
        }
        await writeConfig(config);
    });
}

/**
 * Get skill config
 */
export async function getSkillConfig(skillKey: string): Promise<SkillEntry | undefined> {
    const config = await readConfig();
    return config.skills?.entries?.[skillKey];
}

/**
 * Update skill config (apiKey and env)
 */
export async function updateSkillConfig(
    skillKey: string,
    updates: { apiKey?: string; env?: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
    try {
        return await withConfigLock(async () => {
            const config = await readConfig();

            // Ensure skills.entries exists
            if (!config.skills) {
                config.skills = {};
            }
            if (!config.skills.entries) {
                config.skills.entries = {};
            }

            // Get or create skill entry
            const entry = config.skills.entries[skillKey] || {};

            // Update apiKey
            if (updates.apiKey !== undefined) {
                const trimmed = updates.apiKey.trim();
                if (trimmed) {
                    entry.apiKey = trimmed;
                } else {
                    delete entry.apiKey;
                }
            }

            // Update env
            if (updates.env !== undefined) {
                const newEnv: Record<string, string> = {};

                for (const [key, value] of Object.entries(updates.env)) {
                    const trimmedKey = key.trim();
                    if (!trimmedKey) continue;

                    const trimmedVal = value.trim();
                    if (trimmedVal) {
                        newEnv[trimmedKey] = trimmedVal;
                    }
                }

                if (Object.keys(newEnv).length > 0) {
                    entry.env = newEnv;
                } else {
                    delete entry.env;
                }
            }

            // Save entry back
            config.skills.entries[skillKey] = entry;

            await writeConfig(config);
            return { success: true };
        });
    } catch (err) {
        console.error('Failed to update skill config:', err);
        return { success: false, error: String(err) };
    }
}

/**
 * Get all skill configs (for syncing to frontend)
 */
export async function getAllSkillConfigs(): Promise<Record<string, SkillEntry>> {
    const config = await readConfig();
    return config.skills?.entries || {};
}

const BUILTIN_MANIFEST_NAME = 'builtin-manifest.json';
const BUILTIN_MARKER_NAME = '.Cclawd-builtin.json';

export async function getBuiltinSkillDefinitions(): Promise<BuiltinSkillSpec[]> {
    const candidates = [
        join(getResourcesDir(), 'skills', BUILTIN_MANIFEST_NAME),
        join(process.cwd(), 'resources', 'skills', BUILTIN_MANIFEST_NAME),
    ];

    const manifestPath = candidates.find((p) => existsSync(p));
    if (!manifestPath) {
        return [];
    }

    try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as BuiltinManifest;
        if (!Array.isArray(parsed.skills)) {
            return [];
        }
        return parsed.skills.filter((s): s is BuiltinSkillSpec => Boolean(s?.slug));
    } catch (error) {
        logger.warn('Failed to read builtin skills manifest:', error);
        return [];
    }
}

function isPromptInjectedSkill(value: unknown): value is PromptInjectedSkill {
    return Boolean(
        value
        && typeof value === 'object'
        && typeof (value as PromptInjectedSkill).name === 'string'
        && (value as PromptInjectedSkill).name.trim().length > 0,
    );
}

function getLatestSessionRecord(rawSessions: unknown): SessionRecord | null {
    if (!rawSessions || typeof rawSessions !== 'object' || Array.isArray(rawSessions)) {
        return null;
    }

    const records = Object.values(rawSessions as Record<string, unknown>)
        .filter((value): value is SessionRecord => Boolean(value && typeof value === 'object'))
        .filter((session) => Array.isArray(session.skillsSnapshot?.resolvedSkills));

    if (records.length === 0) {
        return null;
    }

    return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}

/**
 * Return the skills that are actually present in the latest Main Agent
 * skills snapshot. This is the closest Desktop-side view of the skills
 * injected into the model-facing <available_skills> prompt.
 */
export async function getMainAgentPromptInjectedSkills(): Promise<PromptInjectedSkill[]> {
    const sessionsPath = join(homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
    if (!existsSync(sessionsPath)) {
        return [];
    }

    try {
        const raw = await readFile(sessionsPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        const latest = getLatestSessionRecord(parsed);
        const resolvedSkills = latest?.skillsSnapshot?.resolvedSkills;
        if (!Array.isArray(resolvedSkills)) {
            return [];
        }

        return resolvedSkills
            .filter(isPromptInjectedSkill)
            .map((skill) => ({
                name: skill.name.trim(),
                description: skill.description?.trim() || undefined,
                source: skill.source?.trim() || undefined,
                baseDir: skill.baseDir?.trim() || undefined,
                filePath: skill.filePath?.trim() || undefined,
            }));
    } catch (error) {
        logger.warn('Failed to read Main Agent prompt-injected skills:', error);
        return [];
    }
}

function resolveBuiltinSkillsSourceRoot(): string | null {
    const candidates = [
        join(getResourcesDir(), 'builtin-skills'),
        join(process.cwd(), 'resources', 'builtin-skills'),
    ];
    return candidates.find((dir) => existsSync(dir)) || null;
}

/**
 * Ensure built-in skills are deployed to ~/.openclaw/skills/<slug>/.
 * Skips user-managed skills but can repair/update skills previously installed
 * from the cclawd builtin bundle.
 * Runs at app startup; all errors are logged and swallowed so they never
 * block the normal startup flow.
 */
export async function ensureBuiltinSkillsInstalled(): Promise<void> {
    const skills = await getBuiltinSkillDefinitions();
    if (skills.length === 0) {
        return;
    }

    const sourceRoot = resolveBuiltinSkillsSourceRoot();
    if (!sourceRoot) {
        logger.warn('Builtin skills source root not found; skipping builtin skill install.');
        return;
    }

    const skillsRoot = join(homedir(), '.openclaw', 'skills');
    await mkdir(skillsRoot, { recursive: true });
    const toEnable: string[] = [];

    for (const spec of skills) {
        const slug = spec.slug;
        const sourceDir = join(sourceRoot, slug);
        const sourceManifest = join(sourceDir, 'SKILL.md');
        const targetDir = join(skillsRoot, slug);
        const targetManifest = join(targetDir, 'SKILL.md');
        const markerPath = join(targetDir, BUILTIN_MARKER_NAME);
        const legacyPreinstalledMarkerPath = join(targetDir, PREINSTALLED_MARKER_NAME);

        if (!existsSync(sourceManifest)) {
            logger.warn(`Builtin skill source missing SKILL.md, skipping: ${sourceDir}`);
            continue;
        }

        if (existsSync(targetManifest) && !existsSync(markerPath) && !existsSync(legacyPreinstalledMarkerPath)) {
            logger.info(`Skipping user-managed skill with builtin slug: ${slug}`);
            continue;
        }

        try {
            await rm(targetDir, { recursive: true, force: true });
            await mkdir(targetDir, { recursive: true });
            await cp(sourceDir, targetDir, { recursive: true, force: true });
            const markerPayload: BuiltinMarker = {
                source: 'cclawd-builtin',
                slug,
                version: spec.version || '1.0.0',
                installedAt: new Date().toISOString(),
            };
            await writeFile(markerPath, `${JSON.stringify(markerPayload, null, 2)}\n`, 'utf-8');
            if (spec.autoEnable !== false) {
                toEnable.push(slug);
            }
            logger.info(`Installed built-in skill: ${slug} -> ${targetDir}`);
        } catch (error) {
            logger.warn(`Failed to install built-in skill ${slug}:`, error);
        }
    }

    if (toEnable.length > 0) {
        try {
            await setSkillsEnabled(toEnable, true);
        } catch (error) {
            logger.warn('Failed to auto-enable builtin skills:', error);
        }
    }
}

const PREINSTALLED_MANIFEST_NAME = 'preinstalled-manifest.json';
const PREINSTALLED_MARKER_NAME = '.Cclawd-preinstalled.json';
const LEGACY_PREINSTALLED_SKILL_SLUGS = [
    'feishu-doc',
    'feishu-drive',
    'feishu-perm',
    'feishu-wiki',
    'self-improving-agent',
    'self-improvement',
    'tavily-search',
    'brave-web-search',
    'web-search',
] as const;

async function readPreinstalledManifest(): Promise<PreinstalledSkillSpec[]> {
    const candidates = [
        join(getResourcesDir(), 'skills', PREINSTALLED_MANIFEST_NAME),
        join(process.cwd(), 'resources', 'skills', PREINSTALLED_MANIFEST_NAME),
    ];

    const manifestPath = candidates.find((p) => existsSync(p));
    if (!manifestPath) {
        return [];
    }

    try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledManifest;
        if (!Array.isArray(parsed.skills)) {
            return [];
        }
        return parsed.skills.filter((s): s is PreinstalledSkillSpec => Boolean(s?.slug));
    } catch (error) {
        logger.warn('Failed to read preinstalled-skills manifest:', error);
        return [];
    }
}

function resolvePreinstalledSkillsSourceRoot(): string | null {
    const candidates = [
        join(getResourcesDir(), 'preinstalled-skills'),
        join(process.cwd(), 'build', 'preinstalled-skills'),
        join(__dirname, '../../build/preinstalled-skills'),
    ];

    const root = candidates.find((dir) => existsSync(dir));
    return root || null;
}

async function readPreinstalledLockVersions(sourceRoot: string): Promise<Map<string, string>> {
    const lockPath = join(sourceRoot, '.preinstalled-lock.json');
    if (!existsSync(lockPath)) {
        return new Map();
    }
    try {
        const raw = await readFile(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledLockFile;
        const versions = new Map<string, string>();
        for (const entry of parsed.skills || []) {
            const slug = entry.slug?.trim();
            const version = entry.version?.trim();
            if (slug && version) {
                versions.set(slug, version);
            }
        }
        return versions;
    } catch (error) {
        logger.warn('Failed to read preinstalled-skills lock file:', error);
        return new Map();
    }
}

async function tryReadMarker(markerPath: string): Promise<PreinstalledMarker | null> {
    if (!existsSync(markerPath)) {
        return null;
    }
    try {
        const raw = await readFile(markerPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledMarker;
        if (!parsed?.slug || !parsed?.version) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

async function readQoderLockedSkillSlugs(): Promise<Set<string>> {
    const lockPath = join(homedir(), '.openclaw', '.qoder-skills', 'lock.json');
    try {
        const raw = await readFile(lockPath, 'utf-8');
        const parsed = JSON.parse(raw) as { skills?: Record<string, unknown> };
        return new Set(Object.keys(parsed.skills || {}));
    } catch {
        return new Set();
    }
}

async function removeSkillConfigEntries(skillKeys: string[]): Promise<void> {
    if (skillKeys.length === 0) {
        return;
    }
    await withConfigLock(async () => {
        const config = await readConfig();
        if (!config.skills?.entries) {
            return;
        }
        for (const skillKey of skillKeys) {
            delete config.skills.entries[skillKey];
        }
        await writeConfig(config);
    });
}

/**
 * Remove legacy Cclawd default skills that were preinstalled before the Qoder
 * marketplace migration. Qoder-installed skills are protected by its lock file.
 */
export async function cleanupLegacyPreinstalledSkills(): Promise<void> {
    const skillsRoot = join(homedir(), '.openclaw', 'skills');
    const qoderLockedSlugs = await readQoderLockedSkillSlugs();
    const removedSlugs: string[] = [];
    const configSlugsToRemove = LEGACY_PREINSTALLED_SKILL_SLUGS.filter((slug) => !qoderLockedSlugs.has(slug));

    for (const slug of LEGACY_PREINSTALLED_SKILL_SLUGS) {
        if (qoderLockedSlugs.has(slug)) {
            continue;
        }

        const targetDir = join(skillsRoot, slug);
        const targetManifest = join(targetDir, 'SKILL.md');
        if (!existsSync(targetManifest)) {
            continue;
        }

        try {
            await rm(targetDir, { recursive: true, force: true });
            removedSlugs.push(slug);
            logger.info(`Removed legacy preinstalled skill: ${slug}`);
        } catch (error) {
            logger.warn(`Failed to remove legacy preinstalled skill ${slug}:`, error);
        }
    }

    if (configSlugsToRemove.length > 0) {
        try {
            await removeSkillConfigEntries(configSlugsToRemove);
        } catch (error) {
            logger.warn('Failed to remove legacy preinstalled skill config entries:', error);
        }
    }
}

/**
 * Ensure third-party preinstalled skills (bundled in app resources) are
 * deployed to ~/.openclaw/skills/<slug>/ as full directories.
 *
 * Policy:
 * - If skill is missing locally, install it.
 * - If local skill exists without our marker, treat as user-managed and never overwrite.
 * - If marker exists with same version, skip.
 * - If marker exists with a different version, skip by default to avoid overwriting edits.
 */
export async function ensurePreinstalledSkillsInstalled(): Promise<void> {
    const skills = await readPreinstalledManifest();
    if (skills.length === 0) {
        return;
    }

    const sourceRoot = resolvePreinstalledSkillsSourceRoot();
    if (!sourceRoot) {
        logger.warn('Preinstalled skills source root not found; skipping preinstall.');
        return;
    }
    const lockVersions = await readPreinstalledLockVersions(sourceRoot);

    const targetRoot = join(homedir(), '.openclaw', 'skills');
    await mkdir(targetRoot, { recursive: true });
    const toEnable: string[] = [];

    for (const spec of skills) {
        const sourceDir = join(sourceRoot, spec.slug);
        const sourceManifest = join(sourceDir, 'SKILL.md');
        if (!existsSync(sourceManifest)) {
            logger.warn(`Preinstalled skill source missing SKILL.md, skipping: ${sourceDir}`);
            continue;
        }

        const targetDir = join(targetRoot, spec.slug);
        const targetManifest = join(targetDir, 'SKILL.md');
        const markerPath = join(targetDir, PREINSTALLED_MARKER_NAME);
        const desiredVersion = lockVersions.get(spec.slug)
            || (spec.version || 'unknown').trim()
            || 'unknown';
        const marker = await tryReadMarker(markerPath);

        if (existsSync(targetManifest)) {
            if (!marker) {
                logger.info(`Skipping user-managed skill: ${spec.slug}`);
                continue;
            }
            if (marker.version === desiredVersion) {
                continue;
            }
            logger.info(`Skipping preinstalled skill update for ${spec.slug} (local marker version=${marker.version}, desired=${desiredVersion})`);
            continue;
        }

        try {
            await mkdir(targetDir, { recursive: true });
            await cp(sourceDir, targetDir, { recursive: true, force: true });
            const markerPayload: PreinstalledMarker = {
                source: 'Cclawd-preinstalled',
                slug: spec.slug,
                version: desiredVersion,
                installedAt: new Date().toISOString(),
            };
            await writeFile(markerPath, `${JSON.stringify(markerPayload, null, 2)}\n`, 'utf-8');
            if (spec.autoEnable) {
                toEnable.push(spec.slug);
            }
            logger.info(`Installed preinstalled skill: ${spec.slug} -> ${targetDir}`);
        } catch (error) {
            logger.warn(`Failed to install preinstalled skill ${spec.slug}:`, error);
        }
    }

    if (toEnable.length > 0) {
        try {
            await setSkillsEnabled(toEnable, true);
        } catch (error) {
            logger.warn('Failed to auto-enable preinstalled skills:', error);
        }
    }
}
