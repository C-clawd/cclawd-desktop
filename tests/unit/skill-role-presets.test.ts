import { beforeEach, describe, expect, it, vi } from 'vitest';

const setSkillsEnabledMock = vi.fn();
const warnMock = vi.fn();

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}));

vi.mock('@electron/utils/skill-config', () => ({
  setSkillsEnabled: (...args: unknown[]) => setSkillsEnabledMock(...args),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    warn: (...args: unknown[]) => warnMock(...args),
    info: vi.fn(),
  },
}));

describe('skill role presets', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('loads the role preset manifest from resources', async () => {
    const { getRolePresetManifest } = await import('@electron/utils/skill-role-presets');

    const manifest = await getRolePresetManifest();

    expect(manifest.version).toBe(1);
    expect(manifest.baseSkills.map((skill) => skill.slug)).toEqual(
      expect.arrayContaining(['docx', 'xlsx', 'pptx', 'pdf', 'find-skills']),
    );
    expect(manifest.roles.map((role) => role.id)).toEqual([
      'general-office',
      'administration',
      'party-publicity',
      'finance-audit',
      'legal-compliance',
      'project-management',
    ]);
  });

  it('builds a deduped install plan with base and selected role skills', async () => {
    const { buildRolePresetInstallPlan, getRolePresetManifest } = await import('@electron/utils/skill-role-presets');
    const manifest = await getRolePresetManifest();

    const plan = buildRolePresetInstallPlan(manifest, {
      roleIds: ['general-office', 'general-office'],
      includeBaseSkills: true,
    });

    expect(plan.roleIds).toEqual(['general-office']);
    expect(plan.skills.filter((skill) => skill.slug === 'pdf')).toHaveLength(1);
    expect(plan.skills.filter((skill) => skill.slug === 'meeting-summary')).toHaveLength(1);
  });

  it('installs missing qoder skills and skips already installed skills', async () => {
    const installMock = vi.fn().mockResolvedValue(undefined);
    const listInstalledMock = vi.fn().mockResolvedValue([{ slug: 'meeting-summary' }]);
    const { installRolePresetSkills } = await import('@electron/utils/skill-role-presets');

    const result = await installRolePresetSkills({
      install: installMock,
      listInstalled: listInstalledMock,
    } as never, {
      roleIds: ['general-office'],
      includeBaseSkills: false,
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toContain('meeting-summary');
    expect(installMock).toHaveBeenCalledWith({ slug: 'documents' });
    expect(installMock).not.toHaveBeenCalledWith({ slug: 'meeting-summary' });
    expect(setSkillsEnabledMock).toHaveBeenCalledWith(
      expect.arrayContaining(['documents', 'meeting-summary']),
      true,
    );
  });

  it('returns partial failure without enabling failed marketplace skills', async () => {
    const installMock = vi.fn(async ({ slug }: { slug: string }) => {
      if (slug === 'documents') {
        throw new Error('download failed');
      }
    });
    const listInstalledMock = vi.fn().mockResolvedValue([]);
    const { installRolePresetSkills } = await import('@electron/utils/skill-role-presets');

    const result = await installRolePresetSkills({
      install: installMock,
      listInstalled: listInstalledMock,
    } as never, {
      roleIds: ['general-office'],
      includeBaseSkills: true,
    });

    expect(result.success).toBe(false);
    expect(result.failed).toEqual(expect.arrayContaining([expect.objectContaining({ slug: 'documents' })]));
    expect(result.enabled).not.toContain('documents');
    expect(result.enabled).toEqual(expect.arrayContaining(['docx', 'xlsx', 'pdf']));
    expect(setSkillsEnabledMock).toHaveBeenCalledWith(expect.not.arrayContaining(['documents']), true);
  });
});
