/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { useGatewayStore } from './gateway';
import type { Skill, MarketplaceSkill, BuiltinSkillDefinition } from '../types/skill';

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
  source?: string;
  baseDir?: string;
  filePath?: string;
  eligible?: boolean;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type QoderSkillListResult = {
  slug: string;
  version?: string;
  source?: string;
  baseDir?: string;
};

type PromptInjectedSkillResult = {
  name: string;
  description?: string;
  source?: string;
  baseDir?: string;
  filePath?: string;
};

function mapErrorCodeToSkillErrorKey(
  code: AppError['code'],
  operation: 'fetch' | 'search' | 'install',
): string {
  if (code === 'TIMEOUT') {
    return operation === 'search'
      ? 'searchTimeoutError'
      : operation === 'install'
        ? 'installTimeoutError'
        : 'fetchTimeoutError';
  }
  if (code === 'RATE_LIMIT') {
    return operation === 'search'
      ? 'searchRateLimitError'
      : operation === 'install'
        ? 'installRateLimitError'
        : 'fetchRateLimitError';
  }
  return 'rateLimitError';
}

interface SkillsState {
  skills: Skill[];
  builtinSkills: BuiltinSkillDefinition[];
  searchResults: MarketplaceSkill[];
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  error: string | null;

  // Actions
  fetchSkills: () => Promise<void>;
  searchSkills: (query: string, options?: { category?: string; sort?: 'hot' | 'recent'; limit?: number }) => Promise<void>;
  installSkill: (skill: MarketplaceSkill | string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  builtinSkills: [],
  searchResults: [],
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  fetchSkills: async () => {
    // Only show loading state if we have no skills yet (initial load)
    if (get().skills.length === 0) {
      set({ loading: true, error: null });
    }
    try {
      // 1. Fetch from Gateway (running skills)
      const gatewayData = await useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');

      // 2. Fetch Qoder-installed and locally installed skills from disk
      const qoderSkillsResult = await hostApiFetch<{ success: boolean; results?: QoderSkillListResult[]; error?: string }>('/api/qoder-skills/list');

      // 3. Fetch configurations directly from Electron (since Gateway doesn't return them)
      const configResult = await hostApiFetch<Record<string, { enabled?: boolean; apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');
      const builtinResult = await hostApiFetch<{ success: boolean; results?: BuiltinSkillDefinition[]; error?: string }>('/api/skills/builtin');
      const promptInjectedResult = await hostApiFetch<{ success: boolean; results?: PromptInjectedSkillResult[]; error?: string }>('/api/skills/prompt-injected');
      const builtinSkills = builtinResult.success ? (builtinResult.results || []) : [];
      const builtinBySlug = new Map(builtinSkills.map((skill) => [skill.slug, skill]));
      const promptInjectedSkills = promptInjectedResult.success ? (promptInjectedResult.results || []) : [];
      const promptInjectedByName = new Map(promptInjectedSkills.map((skill) => [skill.name, skill]));

      let combinedSkills: Skill[] = [];
      const currentSkills = get().skills;

      // Map gateway skills info
      if (gatewayData.skills) {
        combinedSkills = gatewayData.skills.map((s: GatewaySkillStatus) => {
          // Merge with direct config if available
          const directConfig = configResult[s.skillKey] || {};
          const promptSkill = promptInjectedByName.get(s.skillKey) || promptInjectedByName.get(s.name || '') || promptInjectedByName.get(s.slug || '');
          const skillSlug = s.slug || s.skillKey;
          const builtin = builtinBySlug.get(s.skillKey) || builtinBySlug.get(skillSlug);

          return {
            id: s.skillKey,
            slug: skillSlug,
            name: builtin?.name || s.name || s.skillKey,
            description: builtin?.description || promptSkill?.description || s.description || '',
            enabled: !s.disabled,
            icon: builtin?.icon || s.emoji || 'package',
            version: s.version || builtin?.version || '1.0.0',
            author: s.author,
            config: {
              ...(s.config || {}),
              ...directConfig,
            },
            isCore: s.bundled && s.always,
            isBundled: s.bundled || s.source === 'cclawd-builtin' || Boolean(builtin),
            source: s.source || promptSkill?.source || (builtin ? 'cclawd-builtin' : undefined),
            baseDir: s.baseDir || promptSkill?.baseDir,
            filePath: s.filePath || promptSkill?.filePath,
            useButton: builtin?.useButton,
          };
        });
      } else if (currentSkills.length > 0) {
        // ... if gateway down ...
        combinedSkills = [...currentSkills];
      }

      // Merge with local skill directory results
      if (qoderSkillsResult.success && qoderSkillsResult.results) {
        qoderSkillsResult.results.forEach((skillOnDisk: QoderSkillListResult) => {
          const existing = combinedSkills.find(s => s.id === skillOnDisk.slug);
          if (existing) {
            if (!existing.baseDir && skillOnDisk.baseDir) {
              existing.baseDir = skillOnDisk.baseDir;
            }
            if (!existing.source && skillOnDisk.source) {
              existing.source = skillOnDisk.source;
            }
            return;
          }
          const directConfig = configResult[skillOnDisk.slug] || {};
          const builtin = builtinBySlug.get(skillOnDisk.slug);
          const promptSkill = promptInjectedByName.get(skillOnDisk.slug);
          combinedSkills.push({
            id: skillOnDisk.slug,
            slug: skillOnDisk.slug,
            name: builtin?.name || skillOnDisk.slug,
            description: builtin?.description || promptSkill?.description || 'Recently installed, initializing...',
            enabled: directConfig.enabled !== false,
            icon: builtin?.icon || 'package',
            version: skillOnDisk.version || builtin?.version || 'unknown',
            author: undefined,
            config: directConfig,
            isCore: false,
            isBundled: skillOnDisk.source === 'cclawd-builtin' || Boolean(builtin),
            source: skillOnDisk.source || 'openclaw-managed',
            baseDir: skillOnDisk.baseDir || promptSkill?.baseDir,
            filePath: promptSkill?.filePath,
            useButton: builtin?.useButton,
          });
        });
      }

      if (promptInjectedSkills.length > 0) {
        promptInjectedSkills.forEach((promptSkill) => {
          const existing = combinedSkills.find((skill) => skill.id === promptSkill.name || skill.name === promptSkill.name || skill.slug === promptSkill.name);
          if (existing) return;

          const directConfig = configResult[promptSkill.name] || {};
          const builtin = builtinBySlug.get(promptSkill.name);
          combinedSkills.push({
            id: promptSkill.name,
            slug: promptSkill.name,
            name: builtin?.name || promptSkill.name,
            description: builtin?.description || promptSkill.description || '',
            enabled: true,
            icon: builtin?.icon || 'package',
            version: builtin?.version || 'unknown',
            author: undefined,
            config: directConfig,
            isCore: false,
            isBundled: Boolean(builtin) || promptSkill.source === 'openclaw-bundled',
            source: builtin ? 'cclawd-builtin' : promptSkill.source || 'openclaw-managed',
            baseDir: promptSkill.baseDir,
            filePath: promptSkill.filePath,
            useButton: builtin?.useButton,
          });
        });
      }

      set({ skills: combinedSkills, builtinSkills, loading: false });
    } catch (error) {
      console.error('Failed to fetch skills:', error);
      const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
      set({ loading: false, error: mapErrorCodeToSkillErrorKey(appError.code, 'fetch') });
    }
  },

  searchSkills: async (query: string, options?: { category?: string; sort?: 'hot' | 'recent'; limit?: number }) => {
    set({ searching: true, searchError: null });
    try {
      const result = await hostApiFetch<{ success: boolean; results?: MarketplaceSkill[]; error?: string }>('/api/qoder-skills/search', {
        method: 'POST',
        body: JSON.stringify({ query, category: options?.category, sort: options?.sort, limit: options?.limit ?? 20 }),
      });
      if (result.success) {
        set({ searchResults: result.results || [] });
      } else {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      set({ searchError: mapErrorCodeToSkillErrorKey(appError.code, 'search') });
    } finally {
      set({ searching: false });
    }
  },

  installSkill: async (skill: MarketplaceSkill | string, version?: string) => {
    const slug = typeof skill === 'string' ? skill : skill.slug;
    const installPayload = typeof skill === 'string'
      ? { slug, version }
      : {
        slug: skill.slug,
        version: version || skill.version,
        skillId: skill.skillId,
        downloadUrl: skill.downloadUrl,
      };
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/qoder-skills/install', {
        method: 'POST',
        body: JSON.stringify(installPayload),
      });
      if (!result.success) {
        const appError = normalizeAppError(new Error(result.error || 'Install failed'), {
          module: 'skills',
          operation: 'install',
        });
        throw new Error(mapErrorCodeToSkillErrorKey(appError.code, 'install'));
      }
      // Refresh skills after install
      await get().fetchSkills();
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/qoder-skills/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }
      // Refresh skills after uninstall
      await get().fetchSkills();
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  enableSkill: async (skillId) => {
    const { updateSkill } = get();

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: true });
      updateSkill(skillId, { enabled: true });
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: false });
      updateSkill(skillId, { enabled: false });
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },
}));
