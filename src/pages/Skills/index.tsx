/**
 * Skills Page
 * Browse and manage AI skills.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FileType,
  FolderOpen,
  Hammer,
  Key,
  Package,
  Plus,
  Presentation,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useSkillsStore } from '@/stores/skills';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { toast } from 'sonner';
import type { MarketplaceSkill, Skill } from '@/types/skill';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

type SkillsTab = 'marketplace' | 'builtin' | 'installed';
type MarketSort = 'hot' | 'recent';

const MARKET_CATEGORIES = [
  { value: 'all', labelKey: 'marketplace.categories.all' },
  { value: 'content-creation', labelKey: 'marketplace.categories.contentCreation' },
  { value: 'data-ai', labelKey: 'marketplace.categories.dataAi' },
  { value: 'design-ui', labelKey: 'marketplace.categories.designUi' },
  { value: 'devops-deployment', labelKey: 'marketplace.categories.devops' },
  { value: 'docs-writing', labelKey: 'marketplace.categories.docsWriting' },
  { value: 'productivity', labelKey: 'marketplace.categories.productivity' },
  { value: 'research-analysis', labelKey: 'marketplace.categories.researchAnalysis' },
] as const;

function SkillIcon({ icon, className }: { icon?: string; className?: string }) {
  const normalized = (icon || '').toLowerCase();
  if (normalized === 'hammer') return <Hammer className={className} />;
  if (normalized === 'file-text') return <FileText className={className} />;
  if (normalized === 'file-type') return <FileType className={className} />;
  if (normalized === 'presentation') return <Presentation className={className} />;
  if (normalized === 'file-spreadsheet') return <FileSpreadsheet className={className} />;
  if (normalized === 'search') return <Search className={className} />;
  return <Package className={className} />;
}

function resolveSkillSourceLabel(skill: Skill, t: TFunction<'skills'>): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (source === 'cclawd-builtin') return t('source.badge.cclawdBuiltin');
  if (source === 'cclawd-preinstalled') return t('source.badge.bundled');
  if (source === 'qoder-marketplace') return t('source.badge.qoder');
  if (source === 'openclaw-managed') return t('source.badge.managed');
  if (source === 'openclaw-workspace') return t('source.badge.workspace');
  if (source === 'openclaw-extra') return t('source.badge.extra');
  if (source === 'agents-skills-personal') return t('source.badge.agentsPersonal');
  if (source === 'agents-skills-project') return t('source.badge.agentsProject');
  if (skill.isBundled) return t('source.badge.cclawdBuiltin');
  return source || t('source.badge.unknown');
}

function matchesQuery(skill: Skill, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    skill.name,
    skill.description,
    skill.id,
    skill.slug || '',
    skill.author || '',
  ].some((value) => value.toLowerCase().includes(q));
}

function SkillDetailDialog({
  skill,
  isOpen,
  onClose,
  onToggle,
  onUninstall,
  onOpenFolder,
}: {
  skill: Skill | null;
  isOpen: boolean;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onUninstall?: (slug: string) => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}) {
  const { t } = useTranslation('skills');
  const { fetchSkills } = useSkillsStore();
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [apiKey, setApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!skill) return;
    setApiKey(skill.config?.apiKey ? String(skill.config.apiKey) : '');
    if (skill.config?.env) {
      setEnvVars(Object.entries(skill.config.env).map(([key, value]) => ({ key, value: String(value) })));
    } else {
      setEnvVars([]);
    }
  }, [skill]);

  const handleSaveConfig = async () => {
    if (isSaving || !skill) return;
    setIsSaving(true);
    try {
      const env = envVars.reduce((acc, curr) => {
        const key = curr.key.trim();
        const value = curr.value.trim();
        if (key && value) acc[key] = value;
        return acc;
      }, {} as Record<string, string>);

      const result = await invokeIpc<{ success: boolean; error?: string }>('skill:updateConfig', {
        skillKey: skill.id,
        apiKey: apiKey || '',
        env,
      });
      if (!result.success) throw new Error(result.error || 'Unknown error');
      await fetchSkills();
      toast.success(t('detail.configSaved'));
    } catch (err) {
      toast.error(`${t('toast.failedSave')}: ${String(err)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenReadme = async () => {
    if (!skill) return;
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/qoder-skills/open-readme', {
        method: 'POST',
        body: JSON.stringify({ skillKey: skill.id, slug: skill.slug, baseDir: skill.baseDir }),
      });
      if (!result.success) throw new Error(result.error || t('toast.failedEditor'));
      toast.success(t('toast.openedEditor'));
    } catch (err) {
      toast.error(`${t('toast.failedEditor')}: ${String(err)}`);
    }
  };

  const handleCopyPath = async () => {
    if (!skill?.baseDir) return;
    try {
      await navigator.clipboard.writeText(skill.baseDir);
      toast.success(t('toast.copiedPath'));
    } catch (err) {
      toast.error(`${t('toast.failedCopyPath')}: ${String(err)}`);
    }
  };

  if (!skill) return null;
  const canUninstall = skill.source === 'qoder-marketplace' || (!skill.isBundled && skill.source !== 'cclawd-builtin');

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-[450px] p-0 flex flex-col border-l border-black/10 dark:border-white/10 bg-background dark:bg-card" side="right">
        <div className="flex-1 overflow-y-auto px-8 py-10">
          <div className="flex flex-col items-center mb-8">
            <div className="w-16 h-16 flex items-center justify-center rounded-md bg-white dark:bg-accent border border-black/10 dark:border-white/10 shrink-0 mb-4 shadow-sm">
              <SkillIcon icon={skill.icon} className="h-8 w-8 text-foreground/80" />
            </div>
            <h2 className="text-[26px] text-foreground font-semibold mb-3 text-center tracking-tight">{skill.name}</h2>
            <div className="flex items-center justify-center gap-2 mb-5">
              <Badge variant="secondary" className="font-mono text-[11px] rounded-full border-0">v{skill.version}</Badge>
              <Badge variant="secondary" className="text-[11px] rounded-full border-0">{resolveSkillSourceLabel(skill, t)}</Badge>
            </div>
            <p className="text-[14px] text-foreground/70 leading-[1.6] text-center px-2">{skill.description}</p>
          </div>

          <div className="space-y-7">
            <div className="space-y-2">
              <h3 className="text-[13px] font-bold text-foreground/80">{t('detail.source')}</h3>
              <div className="flex items-center gap-2">
                <Input value={skill.baseDir || t('detail.pathUnavailable')} readOnly className="h-[38px] font-mono text-[12px]" />
                <Button variant="outline" size="icon" className="h-[38px] w-[38px]" disabled={!skill.baseDir} onClick={handleCopyPath} title={t('detail.copyPath')}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button variant="outline" size="icon" className="h-[38px] w-[38px]" disabled={!skill.baseDir} onClick={() => onOpenFolder?.(skill)} title={t('detail.openActualFolder')}>
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {!skill.isCore && (
              <div className="space-y-2">
                <h3 className="text-[13px] font-bold flex items-center gap-2 text-foreground/80">
                  <Key className="h-3.5 w-3.5 text-blue-500" />
                  {t('detail.apiKey')}
                </h3>
                <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder={t('detail.apiKeyPlaceholder')} className="h-[42px]" />
                <p className="text-[12px] text-foreground/50">{t('detail.apiKeyDesc')}</p>
              </div>
            )}

            {!skill.isCore && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-foreground/80">{t('detail.envVars')}</h3>
                  <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}>
                    <Plus className="h-3 w-3 mr-1" />
                    {t('detail.addVariable')}
                  </Button>
                </div>
                {envVars.length === 0 ? (
                  <div className="text-[13px] text-foreground/50 bg-black/5 dark:bg-white/5 rounded-md px-4 py-3">{t('detail.noEnvVars')}</div>
                ) : envVars.map((env, index) => (
                  <div className="flex items-center gap-2" key={index}>
                    <Input value={env.key} onChange={(e) => setEnvVars(envVars.map((item, i) => i === index ? { ...item, key: e.target.value } : item))} placeholder={t('detail.keyPlaceholder')} className="h-9 font-mono text-[12px]" />
                    <Input value={env.value} onChange={(e) => setEnvVars(envVars.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} placeholder={t('detail.valuePlaceholder')} className="h-9 font-mono text-[12px]" />
                    <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive" onClick={() => setEnvVars(envVars.filter((_, i) => i !== index))}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-8 flex items-center justify-center gap-3">
            <Button onClick={handleSaveConfig} disabled={isSaving} className="flex-1 h-[40px] rounded-md">
              {isSaving ? t('detail.saving') : t('detail.saveConfig')}
            </Button>
            <Button variant="outline" className="h-[40px] rounded-md" onClick={handleOpenReadme}>
              {t('detail.openManual')}
            </Button>
            {canUninstall ? (
              <Button variant="destructive" className="h-[40px] rounded-md" onClick={() => skill.slug && onUninstall?.(skill.slug)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : (
              <Button variant="outline" className="h-[40px] rounded-md" onClick={() => onToggle(!skill.enabled)}>
                {skill.enabled ? t('detail.disable') : t('detail.enable')}
              </Button>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MarketSkillCard({
  skill,
  installed,
  loading,
  onInstall,
}: {
  skill: MarketplaceSkill;
  installed: boolean;
  loading: boolean;
  onInstall: (skill: MarketplaceSkill) => void;
}) {
  const { t } = useTranslation('skills');
  return (
    <div
      className="group min-h-[154px] rounded-lg border border-black/10 dark:border-white/10 bg-background hover:bg-black/[0.025] dark:hover:bg-white/[0.04] transition-colors p-4 cursor-pointer"
      onClick={() => invokeIpc('shell:openExternal', `https://qoder.com.cn/marketplace/skill?id=${encodeURIComponent(skill.skillId || skill.slug)}`)}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-md border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 overflow-hidden flex items-center justify-center shrink-0">
            {skill.iconUrl ? <img src={skill.iconUrl} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-foreground/70" />}
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground truncate">{skill.name}</h3>
            <p className="text-[12px] text-muted-foreground font-mono truncate">{skill.slug}</p>
          </div>
        </div>
        <button
          type="button"
          className={cn(
            "h-8 w-8 rounded-md flex items-center justify-center shrink-0 hover:bg-black/5 dark:hover:bg-white/10",
            installed ? "text-emerald-500" : "text-foreground",
          )}
          disabled={installed || loading}
          onClick={(event) => {
            event.stopPropagation();
            if (!installed) onInstall(skill);
          }}
          title={installed ? t('marketplace.installed') : t('marketplace.install')}
        >
          {loading ? <LoadingSpinner size="sm" /> : installed ? <Check className="h-4 w-4" /> : <Plus className="h-5 w-5" />}
        </button>
      </div>
      <p className="mt-4 text-[13px] leading-5 text-muted-foreground line-clamp-2">{skill.description}</p>
      <div className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t('marketplace.downloads', { count: skill.downloads || 0 })}</span>
        {skill.category && <span className="truncate">{skill.category}</span>}
      </div>
    </div>
  );
}

function SkillListRow({
  skill,
  onToggle,
  onOpen,
  onUninstall,
}: {
  skill: Skill;
  onToggle: (skillId: string, enabled: boolean) => void;
  onOpen: (skill: Skill) => void;
  onUninstall?: (slug: string) => void;
}) {
  const { t } = useTranslation('skills');
  const canUninstall = skill.source === 'qoder-marketplace';
  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-black/10 dark:border-white/10 last:border-0 bg-background">
      <button
        type="button"
        className="h-10 w-10 rounded-md border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 flex items-center justify-center shadow-sm shrink-0"
        onClick={() => onOpen(skill)}
      >
        <SkillIcon icon={skill.icon} className="h-5 w-5 text-foreground/80" />
      </button>
      <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onOpen(skill)}>
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-semibold text-foreground truncate">{skill.name}</h3>
          {!skill.isBundled && <Badge variant="secondary" className="h-5 text-[10px] px-1.5 border-0">{resolveSkillSourceLabel(skill, t)}</Badge>}
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground truncate">{skill.description}</p>
      </div>
      {skill.useButton && (
        <Button variant="secondary" size="sm" className="h-8 rounded-md shadow-none">{t('builtin.use')}</Button>
      )}
      {canUninstall && (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => invokeIpc('shell:openExternal', `https://qoder.com.cn/marketplace/skill?id=${encodeURIComponent(skill.slug || skill.id)}`)}>
            <ExternalLink className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => skill.slug && onUninstall?.(skill.slug)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </>
      )}
      <Switch checked={skill.enabled} onCheckedChange={(checked) => onToggle(skill.id, checked)} disabled={skill.isCore} />
    </div>
  );
}

export function Skills() {
  const {
    skills,
    builtinSkills,
    loading,
    error,
    fetchSkills,
    enableSkill,
    disableSkill,
    searchResults,
    searchSkills,
    installSkill,
    uninstallSkill,
    searching,
    searchError,
    installing,
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [activeTab, setActiveTab] = useState<SkillsTab>('marketplace');
  const [searchQuery, setSearchQuery] = useState('');
  const [marketCategory, setMarketCategory] = useState('all');
  const [marketSort, setMarketSort] = useState<MarketSort>('hot');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');
  const isGatewayRunning = gatewayStatus.state === 'running';

  useEffect(() => {
    if (isGatewayRunning) fetchSkills();
  }, [fetchSkills, isGatewayRunning]);

  useEffect(() => {
    invokeIpc<string>('openclaw:getSkillsDir').then((dir) => setSkillsDirPath(dir)).catch(console.error);
  }, []);

  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    const timer = setTimeout(() => {
      searchSkills(searchQuery.trim(), { category: marketCategory, sort: marketSort });
    }, 250);
    return () => clearTimeout(timer);
  }, [activeTab, searchQuery, marketCategory, marketSort, searchSkills]);

  const builtinSlugSet = useMemo(() => new Set(builtinSkills.map((skill) => skill.slug)), [builtinSkills]);
  const safeSkills = Array.isArray(skills) ? skills : [];
  const installedSkillSlugs = new Set(safeSkills.map((skill) => skill.slug || skill.id));
  const builtinInstalledSkills = safeSkills
    .filter((skill) => skill.source === 'cclawd-builtin' || builtinSlugSet.has(skill.slug || skill.id))
    .filter((skill) => matchesQuery(skill, searchQuery));
  const installedSkills = safeSkills.filter((skill) => matchesQuery(skill, searchQuery));
  const installedCount = installedSkills.length;

  const handleToggle = useCallback(async (skillId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await enableSkill(skillId);
        toast.success(t('toast.enabled'));
      } else {
        await disableSkill(skillId);
        toast.success(t('toast.disabled'));
      }
    } catch (err) {
      toast.error(String(err));
    }
  }, [disableSkill, enableSkill, t]);

  const handleInstall = useCallback(async (skill: MarketplaceSkill) => {
    try {
      await installSkill(skill);
      await enableSkill(skill.slug);
      toast.success(t('toast.installed'));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.startsWith('install')) {
        toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
      } else {
        toast.error(`${t('toast.failedInstall')}: ${errorMessage}`);
      }
    }
  }, [enableSkill, installSkill, skillsDirPath, t]);

  const handleUninstall = useCallback(async (slug: string) => {
    try {
      await uninstallSkill(slug);
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      toast.error(`${t('toast.failedUninstall')}: ${String(err)}`);
    }
  }, [t, uninstallSkill]);

  const handleOpenSkillFolder = useCallback(async (skill: Skill) => {
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/qoder-skills/open-path', {
        method: 'POST',
        body: JSON.stringify({ skillKey: skill.id, slug: skill.slug, baseDir: skill.baseDir }),
      });
      if (!result.success) throw new Error(result.error || 'Failed to open folder');
    } catch (err) {
      toast.error(`${t('toast.failedOpenActualFolder')}: ${String(err)}`);
    }
  }, [t]);

  const openSkillsFolder = useCallback(async () => {
    try {
      const result = await invokeIpc<string>('shell:openPath', skillsDirPath);
      if (result) throw new Error(result);
    } catch (err) {
      toast.error(`${t('toast.failedOpenFolder')}: ${String(err)}`);
    }
  }, [skillsDirPath, t]);

  if (loading) {
    return (
      <div className="flex flex-col -m-6 min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden bg-background">
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full p-8 pt-12">
        <div className="flex items-start justify-between mb-5 gap-4">
          <div>
            <h1 className="text-[32px] font-bold tracking-tight text-foreground">{t('title')}</h1>
            <p className="mt-2 text-[14px] text-muted-foreground">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={fetchSkills} disabled={!isGatewayRunning} title={t('refresh')}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button className="h-9 rounded-md gap-2" onClick={openSkillsFolder}>
              <Plus className="h-4 w-4" />
              {t('actions.add')}
            </Button>
          </div>
        </div>

        {!isGatewayRunning && (
          <div className="mb-4 p-3 rounded-md border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            <span className="text-yellow-700 dark:text-yellow-400 text-sm">{t('gatewayWarning')}</span>
          </div>
        )}

        {error && isGatewayRunning && (
          <div className="mb-4 p-3 rounded-md border border-destructive/50 bg-destructive/10 text-destructive text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <span>{t(`toast.${error}`)}</span>
          </div>
        )}

        <div className="mb-4 rounded-lg bg-[#eaf7ff] dark:bg-white/[0.04] h-[118px] px-6 flex items-center justify-between overflow-hidden border border-black/5 dark:border-white/10">
          <div>
            <h2 className="text-[18px] font-semibold text-foreground">{t('hero.title')}</h2>
            <p className="mt-2 text-[13px] text-muted-foreground max-w-[520px]">{t('hero.subtitle')}</p>
          </div>
          <div className="hidden md:flex gap-3 rotate-6 pr-8">
            <div className="h-20 w-28 rounded-md bg-white shadow-sm border border-black/10 flex flex-col items-center justify-center text-orange-500">
              <Presentation className="h-8 w-8" />
              <span className="mt-1 text-[10px] text-muted-foreground">PPT</span>
            </div>
            <div className="h-20 w-28 rounded-md bg-white shadow-sm border border-black/10 flex flex-col items-center justify-center text-blue-500 -rotate-12">
              <FileText className="h-8 w-8" />
              <span className="mt-1 text-[10px] text-muted-foreground">DOC</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-black/10 dark:border-white/10 pb-3 mb-4 gap-4">
          <div className="flex items-center gap-5">
            {(['marketplace', 'builtin', 'installed'] as SkillsTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setActiveTab(tab);
                  setSearchQuery('');
                }}
                className={cn("text-[15px] font-semibold transition-colors", activeTab === tab ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {t(`tabs.${tab}`)}
                {tab === 'installed' && <span className="ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-black/5 dark:bg-white/10 px-1.5 text-[11px]">{installedCount}</span>}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="relative flex items-center h-9 w-[220px] rounded-full border border-black/10 dark:border-white/10 px-3 bg-background">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={activeTab === 'marketplace' ? t('searchMarketplace') : t('search')}
                className="ml-2 min-w-0 flex-1 bg-transparent outline-none text-[13px] placeholder:text-muted-foreground"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {activeTab === 'marketplace' && (
              <>
                <div className="relative">
                  <SlidersHorizontal className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <Select value={marketCategory} onChange={(event) => setMarketCategory(event.target.value)} className="h-9 w-[128px] rounded-md pl-8 text-[13px]">
                    {MARKET_CATEGORIES.map((category) => (
                      <option key={category.value} value={category.value}>{t(category.labelKey)}</option>
                    ))}
                  </Select>
                </div>
                <Select value={marketSort} onChange={(event) => setMarketSort(event.target.value as MarketSort)} className="h-9 w-[116px] rounded-md text-[13px]">
                  <option value="hot">{t('marketplace.sort.hot')}</option>
                  <option value="recent">{t('marketplace.sort.recent')}</option>
                </Select>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-8 min-h-0">
          {activeTab === 'marketplace' && (
            <div>
              <h2 className="mb-3 text-[13px] font-semibold text-foreground">{t('marketplace.official')}</h2>
              {searchError && (
                <div className="mb-4 p-3 rounded-md border border-destructive/50 bg-destructive/10 text-destructive text-sm">{t(`toast.${searchError}`, { path: skillsDirPath })}</div>
              )}
              {searching ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <LoadingSpinner size="lg" />
                  <p className="mt-4 text-sm">{t('marketplace.searching')}</p>
                </div>
              ) : searchResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Package className="h-10 w-10 mb-4 opacity-50" />
                  <p>{searchQuery.trim() ? t('marketplace.noResults') : t('marketplace.emptyPrompt')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {searchResults.map((skill) => (
                    <MarketSkillCard
                      key={skill.skillId || skill.slug}
                      skill={skill}
                      installed={installedSkillSlugs.has(skill.slug)}
                      loading={!!installing[skill.slug]}
                      onInstall={handleInstall}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'builtin' && (
            <div>
              <h2 className="mb-3 text-[13px] font-semibold text-foreground">{t('builtin.title')}</h2>
              <div className="rounded-lg border border-black/10 dark:border-white/10 overflow-hidden">
                {builtinInstalledSkills.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground">{t('noSkillsAvailable')}</div>
                ) : builtinInstalledSkills.map((skill) => (
                  <SkillListRow key={skill.id} skill={skill} onToggle={handleToggle} onOpen={setSelectedSkill} />
                ))}
              </div>
            </div>
          )}

          {activeTab === 'installed' && (
            <div className="space-y-6">
              <div>
                <h2 className="mb-3 text-[13px] font-semibold text-foreground">{t('installed.loaded')}</h2>
                <div className="rounded-lg border border-black/10 dark:border-white/10 overflow-hidden">
                  {installedSkills.length === 0 ? (
                    <div className="py-10 text-center text-muted-foreground">{t('installed.emptyLoaded')}</div>
                  ) : installedSkills.map((skill) => (
                    <SkillListRow key={skill.id} skill={skill} onToggle={handleToggle} onOpen={setSelectedSkill} onUninstall={handleUninstall} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <SkillDetailDialog
        skill={selectedSkill}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onToggle={(enabled) => {
          if (!selectedSkill) return;
          handleToggle(selectedSkill.id, enabled);
          setSelectedSkill({ ...selectedSkill, enabled });
        }}
        onUninstall={handleUninstall}
        onOpenFolder={handleOpenSkillFolder}
      />
    </div>
  );
}

export default Skills;
