/**
 * Qoder Marketplace Skill Service
 * Searches and installs skills from Qoder China Marketplace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { shell } from 'electron';
import { getOpenClawConfigDir, ensureDir } from '../utils/paths';
import { proxyAwareFetch } from '../utils/proxy-fetch';

const require = createRequire(import.meta.url);
const extractZip = require('extract-zip') as typeof import('extract-zip');

const QODER_MARKETPLACE_BASE_URL = 'https://qoder.com.cn';
const QODER_SKILLS_API = `${QODER_MARKETPLACE_BASE_URL}/api/v1/marketplace/skills`;
const QODER_LOCK_RELATIVE_PATH = path.join('.qoder-skills', 'lock.json');
const MARKETPLACE_SEARCH_LIMIT = 20;

export interface QoderSkillSearchParams {
    query?: string;
    limit?: number;
    category?: string;
    sort?: 'hot' | 'recent';
}

export interface QoderSkillInstallParams {
    slug: string;
    version?: string;
    force?: boolean;
    skillId?: string;
    downloadUrl?: string;
}

export interface QoderSkillUninstallParams {
    slug: string;
}

export interface QoderSkillResult {
    slug: string;
    skillId?: string;
    name: string;
    description: string;
    version: string;
    author?: string;
    downloads?: number;
    stars?: number;
    category?: string;
    iconUrl?: string;
    downloadUrl?: string;
}

export interface QoderInstalledSkillResult {
    slug: string;
    version: string;
    source?: string;
    baseDir?: string;
}

interface QoderApiSkill {
    skill_id?: string;
    skill_name?: string;
    skill_name_cn?: string;
    description?: string;
    description_cn?: string;
    version?: string;
    author?: string;
    author_name?: string;
    install_count?: number;
    category?: string;
    icon_url?: string;
    download_url?: string;
    updated_at?: string;
    created_at?: string;
}

interface QoderSkillPageResponse {
    skills?: QoderApiSkill[];
    pages?: number | {
        current_page?: number | string;
        last_page?: number | string;
        next_page?: number | string;
        page_size?: number | string;
        total_size?: number | string;
    };
}

interface QoderLockSkill {
    skillId?: string;
    slug: string;
    version?: string;
    source?: string;
    downloadUrl?: string;
    installedAt?: string;
}

interface QoderLockFile {
    version: 1;
    skills: Record<string, QoderLockSkill>;
}

export class QoderSkillService {
    private workDir: string;
    private skillsDir: string;
    private lockFilePath: string;

    constructor() {
        this.workDir = getOpenClawConfigDir();
        this.skillsDir = path.join(this.workDir, 'skills');
        this.lockFilePath = path.join(this.workDir, QODER_LOCK_RELATIVE_PATH);
        ensureDir(this.workDir);
        ensureDir(this.skillsDir);
    }

    private normalizeLimit(limit?: number): number {
        if (typeof limit !== 'number' || !Number.isFinite(limit)) return MARKETPLACE_SEARCH_LIMIT;
        return Math.min(Math.max(Math.floor(limit), 1), MARKETPLACE_SEARCH_LIMIT);
    }

    private toDisplayText(primary?: string, fallback?: string): string {
        const trimmedPrimary = primary?.trim();
        if (trimmedPrimary) return trimmedPrimary;
        const trimmedFallback = fallback?.trim();
        return trimmedFallback || '';
    }

    private mapApiSkill(item: QoderApiSkill): QoderSkillResult | null {
        const slug = item.skill_name?.trim();
        if (!slug) return null;
        return {
            slug,
            skillId: item.skill_id?.trim(),
            name: this.toDisplayText(item.skill_name_cn, item.skill_name) || slug,
            description: this.toDisplayText(item.description_cn, item.description),
            version: item.version?.trim() || 'latest',
            author: this.toDisplayText(item.author_name, item.author) || undefined,
            downloads: typeof item.install_count === 'number' ? item.install_count : undefined,
            category: item.category?.trim() || undefined,
            iconUrl: item.icon_url?.trim() || undefined,
            downloadUrl: item.download_url?.trim() || undefined,
        };
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const response = await proxyAwareFetch(url, {
            headers: {
                Accept: 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Qoder Marketplace request failed: ${response.status} ${response.statusText}`);
        }
        return await response.json() as T;
    }

    private async fetchSkillPage(page: number, pageSize: number, query?: string): Promise<QoderSkillPageResponse> {
        const requestUrl = new URL(QODER_SKILLS_API);
        requestUrl.searchParams.set('page', String(page));
        requestUrl.searchParams.set('page_size', String(pageSize));

        if (query) {
            requestUrl.searchParams.set('keyword', query);
        }

        return await this.fetchJson<QoderSkillPageResponse>(requestUrl.toString());
    }

    private normalizeCategory(category?: string): string | undefined {
        const normalized = category?.trim();
        return normalized && normalized !== 'all' ? normalized : undefined;
    }

    private filterByCategory(skills: QoderSkillResult[], category?: string): QoderSkillResult[] {
        const normalized = this.normalizeCategory(category);
        if (!normalized) return skills;
        return skills.filter((skill) => skill.category === normalized);
    }

    private sortSkills(skills: QoderSkillResult[], sort?: 'hot' | 'recent'): QoderSkillResult[] {
        if (sort === 'recent') {
            return [...skills];
        }
        return [...skills].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    }

    private dedupeSkills(skills: QoderSkillResult[]): QoderSkillResult[] {
        const seen = new Set<string>();
        const results: QoderSkillResult[] = [];

        for (const skill of skills) {
            const key = (skill.skillId || skill.slug).trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push(skill);
        }

        return results;
    }

    private getLastPage(data: QoderSkillPageResponse): number {
        if (typeof data.pages === 'number') {
            return Math.max(1, Math.floor(data.pages));
        }

        const lastPage = data.pages?.last_page;
        const parsedLastPage = typeof lastPage === 'number'
            ? lastPage
            : typeof lastPage === 'string'
                ? Number.parseInt(lastPage, 10)
                : 1;
        return Number.isFinite(parsedLastPage) ? Math.max(1, Math.floor(parsedLastPage)) : 1;
    }

    private async fetchSkillPagesInBatches(pages: number[], pageSize: number, query?: string): Promise<QoderSkillPageResponse[]> {
        const batchSize = 5;
        const results: QoderSkillPageResponse[] = [];

        for (let index = 0; index < pages.length; index += batchSize) {
            const batch = pages.slice(index, index + batchSize);
            results.push(...await Promise.all(
                batch.map((page) => this.fetchSkillPage(page, pageSize, query)),
            ));
        }

        return results;
    }

    async search(params: QoderSkillSearchParams): Promise<QoderSkillResult[]> {
        const query = params.query?.trim() || undefined;
        const category = this.normalizeCategory(params.category);
        const limit = this.normalizeLimit(params.limit);
        const data = await this.fetchSkillPage(1, limit, query);
        const mapped = (data.skills || [])
            .map((item) => this.mapApiSkill(item))
            .filter((item): item is QoderSkillResult => item !== null);
        const results = this.sortSkills(this.filterByCategory(this.dedupeSkills(mapped), category), params.sort);
        return results.slice(0, limit);
    }

    private async getSkillDetail(skillId: string): Promise<QoderSkillResult> {
        const detail = await this.fetchJson<QoderApiSkill>(`${QODER_SKILLS_API}/${encodeURIComponent(skillId)}/detail`);
        const mapped = this.mapApiSkill(detail);
        if (!mapped) {
            throw new Error(`Invalid Qoder skill detail for ${skillId}`);
        }
        return mapped;
    }

    private async findSkillBySlug(slug: string): Promise<QoderSkillResult | null> {
        const results = await this.search({ query: slug, limit: 20 });
        return results.find((skill) => skill.slug === slug) || results[0] || null;
    }

    private sanitizeSlug(slug: string): string {
        const trimmed = slug.trim();
        if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
            throw new Error(`Invalid skill slug: ${slug}`);
        }
        return trimmed;
    }

    private async downloadZip(downloadUrl: string, targetPath: string): Promise<void> {
        const response = await proxyAwareFetch(downloadUrl);
        if (!response.ok) {
            throw new Error(`Qoder skill download failed: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        await fs.promises.writeFile(targetPath, Buffer.from(arrayBuffer));
    }

    private async resolveExtractedSkillDir(extractDir: string, slug: string): Promise<string> {
        const directDir = path.join(extractDir, slug);
        if (fs.existsSync(path.join(directDir, 'SKILL.md'))) {
            return directDir;
        }

        if (fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
            return extractDir;
        }

        const entries = await fs.promises.readdir(extractDir, { withFileTypes: true });
        const skillDirs = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(extractDir, entry.name))
            .filter((dir) => fs.existsSync(path.join(dir, 'SKILL.md')));

        if (skillDirs.length === 1) {
            return skillDirs[0];
        }

        throw new Error('Downloaded Qoder skill package does not contain a recognizable SKILL.md');
    }

    private async replaceDirectory(sourceDir: string, targetDir: string): Promise<void> {
        await fs.promises.rm(targetDir, { recursive: true, force: true });
        await fs.promises.mkdir(path.dirname(targetDir), { recursive: true });
        await fs.promises.cp(sourceDir, targetDir, { recursive: true });
    }

    private readLockFile(): QoderLockFile {
        try {
            const raw = fs.readFileSync(this.lockFilePath, 'utf8');
            const parsed = JSON.parse(raw) as Partial<QoderLockFile>;
            if (parsed.version === 1 && parsed.skills && typeof parsed.skills === 'object') {
                return { version: 1, skills: parsed.skills };
            }
        } catch {
            // Ignore malformed or missing lock files.
        }
        return { version: 1, skills: {} };
    }

    private async writeLockFile(lockFile: QoderLockFile): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.lockFilePath), { recursive: true });
        await fs.promises.writeFile(this.lockFilePath, JSON.stringify(lockFile, null, 2), 'utf8');
    }

    private extractFrontmatterField(skillManifestPath: string, field: string): string | null {
        try {
            const raw = fs.readFileSync(skillManifestPath, 'utf8');
            const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
            if (!frontmatterMatch) return null;
            const body = frontmatterMatch[1];
            const fieldPattern = new RegExp(`^\\s*${field}\\s*:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm');
            const fieldMatch = body.match(fieldPattern);
            return fieldMatch?.[1]?.trim() || null;
        } catch {
            return null;
        }
    }

    private getLocalSkillSource(slug: string, baseDir: string, lockSkill?: QoderLockSkill): string {
        if (lockSkill?.source) return lockSkill.source;
        if (fs.existsSync(path.join(baseDir, '.Cclawd-builtin.json'))) return 'cclawd-builtin';
        if (fs.existsSync(path.join(baseDir, '.Cclawd-preinstalled.json'))) return 'cclawd-preinstalled';
        return 'openclaw-managed';
    }

    async install(params: QoderSkillInstallParams): Promise<void> {
        const slug = this.sanitizeSlug(params.slug);
        let skill: QoderSkillResult | null = null;

        if (params.downloadUrl) {
            skill = {
                slug,
                skillId: params.skillId,
                name: slug,
                description: '',
                version: params.version || 'latest',
                downloadUrl: params.downloadUrl,
            };
        } else if (params.skillId) {
            skill = await this.getSkillDetail(params.skillId);
        } else {
            skill = await this.findSkillBySlug(slug);
        }

        const downloadUrl = skill?.downloadUrl?.trim();
        if (!downloadUrl) {
            throw new Error(`Qoder skill download URL not found for ${slug}`);
        }

        const tempDir = await fs.promises.mkdtemp(path.join(tmpdir(), 'cclawd-qoder-skill-'));
        const zipPath = path.join(tempDir, `${slug}.zip`);
        const extractDir = path.join(tempDir, 'extract');

        try {
            await fs.promises.mkdir(extractDir, { recursive: true });
            await this.downloadZip(downloadUrl, zipPath);
            await extractZip(zipPath, { dir: extractDir });

            const sourceSkillDir = await this.resolveExtractedSkillDir(extractDir, slug);
            const targetSkillDir = path.join(this.skillsDir, slug);
            await this.replaceDirectory(sourceSkillDir, targetSkillDir);

            const lockFile = this.readLockFile();
            lockFile.skills[slug] = {
                skillId: skill?.skillId || params.skillId,
                slug,
                version: skill?.version || params.version || 'latest',
                source: 'qoder-marketplace',
                downloadUrl,
                installedAt: new Date().toISOString(),
            };
            await this.writeLockFile(lockFile);
        } finally {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
    }

    async uninstall(params: QoderSkillUninstallParams): Promise<void> {
        const slug = this.sanitizeSlug(params.slug);
        await fs.promises.rm(path.join(this.skillsDir, slug), { recursive: true, force: true });

        const lockFile = this.readLockFile();
        if (lockFile.skills[slug]) {
            delete lockFile.skills[slug];
            await this.writeLockFile(lockFile);
        }
    }

    async listInstalled(): Promise<QoderInstalledSkillResult[]> {
        if (!fs.existsSync(this.skillsDir)) return [];

        const lockFile = this.readLockFile();
        const entries = await fs.promises.readdir(this.skillsDir, { withFileTypes: true });
        const results: QoderInstalledSkillResult[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const slug = entry.name;
            const baseDir = path.join(this.skillsDir, slug);
            const manifestPath = path.join(baseDir, 'SKILL.md');
            if (!fs.existsSync(manifestPath)) continue;

            const lockSkill = lockFile.skills[slug];
            const manifestVersion = this.extractFrontmatterField(manifestPath, 'version');
            results.push({
                slug,
                version: lockSkill?.version || manifestVersion || 'unknown',
                source: this.getLocalSkillSource(slug, baseDir, lockSkill),
                baseDir,
            });
        }
        return results;
    }

    private resolveSkillDir(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): string | null {
        const candidates = [skillKeyOrSlug, fallbackSlug]
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .map((value) => value.trim());

        if (preferredBaseDir?.trim() && fs.existsSync(preferredBaseDir.trim())) {
            return preferredBaseDir.trim();
        }

        return candidates
            .map((candidate) => path.join(this.skillsDir, candidate))
            .find((candidateDir) => fs.existsSync(candidateDir)) || null;
    }

    async openSkillReadme(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
        if (!skillDir) {
            throw new Error('Skill directory not found');
        }

        const possibleFiles = ['SKILL.md', 'README.md', 'skill.md', 'readme.md'];
        const targetPath = possibleFiles
            .map((file) => path.join(skillDir, file))
            .find((filePath) => fs.existsSync(filePath)) || skillDir;

        const openResult = await shell.openPath(targetPath);
        if (openResult) {
            throw new Error(openResult);
        }
        return true;
    }

    async openSkillPath(skillKeyOrSlug: string, fallbackSlug?: string, preferredBaseDir?: string): Promise<boolean> {
        const skillDir = this.resolveSkillDir(skillKeyOrSlug, fallbackSlug, preferredBaseDir);
        if (!skillDir) {
            throw new Error('Skill directory not found');
        }

        const openResult = await shell.openPath(skillDir);
        if (openResult) {
            throw new Error(openResult);
        }
        return true;
    }
}
