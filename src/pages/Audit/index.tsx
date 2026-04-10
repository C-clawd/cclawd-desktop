import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Copy,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { hostApiFetch } from '@/lib/host-api';
import { cn } from '@/lib/utils';

type WindowKey = '24h' | '7d' | '30d';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'safe';
type ActionType = 'allow' | 'alert' | 'block';
type SourceType = 'behavior' | 'content' | 'event-stream' | 'static';

type AuditOverview = {
  totalEvents: number;
  blockedEvents: number;
  highRiskEvents: number;
  blockRate: number;
};

type TimelinePoint = {
  bucket: string;
  total: number;
};

type TopListItem = {
  name: string;
  count: number;
};

type AuditRow = {
  id: string;
  createdAt: string;
  source: SourceType;
  riskLevel: RiskLevel;
  action: ActionType;
  riskType: string;
  ruleId: string;
  summary: string;
  sessionKey: string;
  runId: string;
  detail?: {
    context?: {
      userInstruction?: string;
      triggerTool?: string;
      triggerParams?: string;
      hookType?: string;
      stepSeq?: string;
      toolCallId?: string;
      recentUserMessages?: string[];
    };
    evidence?: {
      sourceType?: string;
      ruleId?: string;
      reason?: string;
      confidence?: string;
      matchedText?: string;
      riskContent?: string;
    };
  };
};

type ApiResponse<T> = {
  success: boolean;
  data: T;
  error?: string | Record<string, unknown>;
};

type AuditEventsData = {
  total: number;
  items: AuditRow[];
};

function sourceLabel(source: SourceType): string {
  const labels: Record<SourceType, string> = {
    behavior: '\u884c\u4e3a\u68c0\u6d4b',
    content: '\u5185\u5bb9\u68c0\u6d4b',
    'event-stream': '\u4e8b\u4ef6\u6d41',
    static: '\u9759\u6001\u626b\u63cf',
  };
  return labels[source] ?? source;
}

function riskLevelLabel(level: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    low: '\u4f4e',
    medium: '\u4e2d',
    high: '\u9ad8',
    critical: '\u4e25\u91cd',
    safe: '\u5b89\u5168',
  };
  return labels[level] ?? level;
}

function actionLabel(action: ActionType): string {
  if (action === 'block') return '\u62e6\u622a';
  if (action === 'alert') return '\u9884\u8b66';
  return '\u653e\u884c';
}

function riskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    DATA_EXFILTRATION: '\u6570\u636e\u5916\u4f20',
    PROMPT_INJECTION: '\u63d0\u793a\u6ce8\u5165',
    COMMAND_EXECUTION: '\u547d\u4ee4\u6267\u884c',
    CONTENT_SCAN: '\u5185\u5bb9\u626b\u63cf',
    STATIC_SCAN: '\u9759\u6001\u626b\u63cf',
    EVENT_STREAM_RULE: '\u4e8b\u4ef6\u6d41\u89c4\u5219',
    SECRET_LEAK: '\u5bc6\u94a5\u6cc4\u9732',
    PII_EXPOSURE: '\u9690\u79c1\u66b4\u9732',
    UNKNOWN: '\u672a\u77e5',
  };
  return labels[type] ?? type;
}

function riskBadgeClass(level: RiskLevel): string {
  if (level === 'critical') return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20';
  if (level === 'high') return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20';
  if (level === 'medium') return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20';
  if (level === 'safe') return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20';
  return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function formatPercent(decimal: number): string {
  const value = Number.isFinite(decimal) ? decimal : 0;
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value || 0);
}

function formatApiError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return '[object]';
    }
  }
  return 'unknown error';
}

function normalizeInstruction(value?: string): string {
  if (!value || value.trim().length === 0 || value === '-') return '\u672a\u91c7\u96c6';
  return value
    .replace(/```json\s*/g, '')
    .replace(/```/g, '')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .trim();
}

function contextValue(value?: string): string {
  if (value === undefined || value === null) return '\u672a\u91c7\u96c6';
  if (value.trim().length === 0 || value === '-') return '\u4e3a\u7a7a';
  return value;
}

function evidenceValue(value?: string): string {
  if (value === undefined || value === null) return '\u672a\u91c7\u96c6';
  if (value.trim().length === 0 || value === '-') return '\u4e3a\u7a7a';
  return value;
}

function evidenceSourceLabel(sourceType?: string): string {
  const value = (sourceType || '').trim().toLowerCase();
  if (!value) return '\u672a\u91c7\u96c6';
  const map: Record<string, string> = {
    content: '\u5185\u5bb9\u626b\u63cf',
    behavior: '\u884c\u4e3a\u68c0\u6d4b',
    'event-stream': '\u4e8b\u4ef6\u6d41\u68c0\u6d4b',
    static: '\u9759\u6001\u626b\u63cf',
  };
  return map[value] ?? sourceType ?? '\u672a\u91c7\u96c6';
}

function confidenceLabel(confidence?: string): string {
  const value = (confidence || '').trim().toLowerCase();
  if (!value) return '\u672a\u91c7\u96c6';
  const map: Record<string, string> = {
    low: '\u4f4e',
    medium: '\u4e2d',
    high: '\u9ad8',
    critical: '\u4e25\u91cd',
  };
  return map[value] ?? confidence ?? '\u672a\u91c7\u96c6';
}

function reasonLabel(reason?: string): string {
  const value = (reason || '').trim();
  if (!value) return '\u672a\u91c7\u96c6';
  const map: Record<string, string> = {
    'Blocked by event stream rule: suspicious exfiltration or secret exposure signal': '\u4e8b\u4ef6\u6d41\u89c4\u5219\u62e6\u622a\uff1a\u68c0\u6d4b\u5230\u53ef\u7591\u6570\u636e\u5916\u4f20\u6216\u5bc6\u94a5\u66b4\u9732\u4fe1\u53f7',
    'Blocked by event stream rule: destructive command pattern in blocking hook payload': '\u4e8b\u4ef6\u6d41\u89c4\u5219\u62e6\u622a\uff1a\u963b\u65ad Hook \u8d1f\u8f7d\u4e2d\u51fa\u73b0\u7834\u574f\u6027\u547d\u4ee4\u6a21\u5f0f',
    'Blocked by event stream rule: suspicious instruction hijack in blocking hook payload': '\u4e8b\u4ef6\u6d41\u89c4\u5219\u62e6\u622a\uff1a\u963b\u65ad Hook \u8d1f\u8f7d\u4e2d\u51fa\u73b0\u53ef\u7591\u6307\u4ee4\u529d\u6301\u4fe1\u53f7',
    'Email address leakage': '\u68c0\u6d4b\u5230\u90ae\u7bb1\u5730\u5740\u6cc4\u9732',
    'Social Security Number pattern': '\u68c0\u6d4b\u5230\u793e\u4fdd\u53f7\u7b49\u654f\u611f\u53f7\u7801\u6a21\u5f0f',
    'Document marked as confidential': '\u68c0\u6d4b\u5230\u6587\u6863\u4e2d\u5b58\u5728\u4fdd\u5bc6\u6807\u8bb0',
    'Behavior assessment event': '\u884c\u4e3a\u98ce\u9669\u8bc4\u4f30\u4e8b\u4ef6',
  };
  return map[value] ?? value;
}

export function Audit() {
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | SourceType>('all');
  const [riskLevel, setRiskLevel] = useState<'all' | RiskLevel>('all');
  const [action, setAction] = useState<'all' | ActionType>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [copied, setCopied] = useState<'none' | 'instruction' | 'raw'>('none');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [overview, setOverview] = useState<AuditOverview>({
    totalEvents: 0,
    blockedEvents: 0,
    highRiskEvents: 0,
    blockRate: 0,
  });
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [topRiskTypes, setTopRiskTypes] = useState<TopListItem[]>([]);
  const [topRules, setTopRules] = useState<TopListItem[]>([]);
  const [events, setEvents] = useState<AuditEventsData>({ total: 0, items: [] });

  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(events.total / pageSize));
  const safePage = Math.min(page, totalPages);

  const maxTimelineTotal = useMemo(
    () => Math.max(1, ...timeline.map((point) => point.total)),
    [timeline],
  );

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({
        window: windowKey,
        page: String(safePage),
        pageSize: String(pageSize),
      });
      if (source !== 'all') query.set('source', source);
      if (riskLevel !== 'all') query.set('riskLevel', riskLevel);
      if (action !== 'all') query.set('action', action);
      if (search.trim()) query.set('keyword', search.trim());

      const [overviewRes, timelineRes, topRes, eventsRes] = await Promise.all([
        hostApiFetch<ApiResponse<AuditOverview>>(`/api/audit/overview?window=${windowKey}`),
        hostApiFetch<ApiResponse<{ points: TimelinePoint[] }>>(`/api/audit/timeline?window=${windowKey}&granularity=day`),
        hostApiFetch<ApiResponse<{ riskTypes: TopListItem[]; rules: TopListItem[] }>>(`/api/audit/top-risks?window=${windowKey}&limit=10`),
        hostApiFetch<ApiResponse<AuditEventsData>>(`/api/audit/events?${query.toString()}`),
      ]);

      const failures = [
        { name: 'overview', resp: overviewRes as ApiResponse<unknown> },
        { name: 'timeline', resp: timelineRes as ApiResponse<unknown> },
        { name: 'top-risks', resp: topRes as ApiResponse<unknown> },
        { name: 'events', resp: eventsRes as ApiResponse<unknown> },
      ].filter((item) => !item.resp?.success);

      if (failures.length > 0) {
        const details = failures
          .map((item) => `${item.name}: ${formatApiError(item.resp?.error)}`)
          .join('; ');
        throw new Error(`\u5ba1\u8ba1\u63a5\u53e3\u8fd4\u56de\u5931\u8d25 (${details})`);
      }

      setOverview(overviewRes.data);
      setTimeline(timelineRes.data.points ?? []);
      setTopRiskTypes(topRes.data.riskTypes ?? []);
      setTopRules(topRes.data.rules ?? []);
      setEvents(eventsRes.data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      setOverview({ totalEvents: 0, blockedEvents: 0, highRiskEvents: 0, blockRate: 0 });
      setTimeline([]);
      setTopRiskTypes([]);
      setTopRules([]);
      setEvents({ total: 0, items: [] });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPage(1);
  }, [windowKey, source, riskLevel, action, search]);

  useEffect(() => {
    setRawExpanded(false);
    setCopied('none');
  }, [selected?.id]);

  useEffect(() => {
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, source, riskLevel, action, search, safePage]);

  return (
    <div className="flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden dark:bg-background">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-10 pt-16">
        <div className="mb-8 flex shrink-0 flex-col justify-between gap-4 md:flex-row md:items-start">
          <div>
            <h1 className="mb-3 text-5xl font-normal tracking-tight text-foreground md:text-6xl" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
              {'\u5ba1\u8ba1'}
            </h1>
            <p className="text-[17px] font-medium text-foreground/70">{'\u5b89\u5168\u4e8b\u4ef6\u3001\u62e6\u622a\u8d8b\u52bf\u4e0e\u5ba1\u8ba1\u660e\u7ec6'}</p>
          </div>
          <div className="flex items-center gap-2 md:mt-2">
            {(['24h', '7d', '30d'] as WindowKey[]).map((key) => (
              <Button
                key={key}
                variant={windowKey === key ? 'secondary' : 'outline'}
                className={cn('h-9 rounded-full px-4 text-[13px]', windowKey === key ? 'bg-black/10 dark:bg-white/10' : 'border-black/10 bg-transparent dark:border-white/10')}
                onClick={() => setWindowKey(key)}
              >
                {key}
              </Button>
            ))}
            <Button variant="outline" className="h-9 rounded-full border-black/10 bg-transparent px-4 text-[13px] dark:border-white/10" onClick={() => void loadData()} disabled={loading}>
              <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} />
              {'\u5237\u65b0'}
            </Button>
          </div>
        </div>

        <div className="-mr-2 min-h-0 flex-1 space-y-6 overflow-y-auto pb-10 pr-2">
          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">
              {'\u6570\u636e\u52a0\u8f7d\u5931\u8d25\uff1a'}{error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard title={'\u603b\u68c0\u6d4b\u91cf'} value={formatNumber(overview.totalEvents)} icon={<Activity className="h-5 w-5 text-blue-600" />} />
            <MetricCard title={'\u62e6\u622a\u91cf'} value={formatNumber(overview.blockedEvents)} icon={<ShieldCheck className="h-5 w-5 text-emerald-600" />} />
            <MetricCard title={'\u9ad8\u5371\u4e8b\u4ef6'} value={formatNumber(overview.highRiskEvents)} icon={<ShieldAlert className="h-5 w-5 text-orange-600" />} />
            <MetricCard title={'\u62e6\u622a\u7387'} value={formatPercent(overview.blockRate)} icon={<ShieldCheck className="h-5 w-5 text-indigo-600" />} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-black/10 p-5 dark:border-white/10 lg:col-span-2">
              <h2 className="mb-4 text-xl font-semibold">{'\u98ce\u9669\u8d8b\u52bf'}</h2>
              <TimelineBars points={timeline} maxValue={maxTimelineTotal} />
            </div>
            <div className="rounded-2xl border border-black/10 p-5 dark:border-white/10">
              <h2 className="mb-4 text-xl font-semibold">{'\u6765\u6e90\u5360\u6bd4'}</h2>
              <SourceSummary rows={events.items} />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <TopList title={'\u98ce\u9669\u7c7b\u578b Top10'} items={topRiskTypes.map((item) => [riskTypeLabel(item.name), item.count])} />
            <TopList title={'\u89c4\u5219\u547d\u4e2d Top10'} items={topRules.map((item) => [item.name, item.count])} />
          </div>

          <div className="rounded-2xl border border-black/10 p-4 dark:border-white/10">
            <div className="flex flex-col gap-3 lg:flex-row">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={'\u641c\u7d22 \u98ce\u9669\u7c7b\u578b / \u6458\u8981 / sessionKey / runId'} className="h-10 border-black/10 pl-9 dark:border-white/10" />
              </div>
              <SelectLike
                icon={<Filter className="h-4 w-4" />}
                value={source}
                onChange={setSource}
                options={[
                  ['all', '\u6765\u6e90: \u5168\u90e8'],
                  ['behavior', '\u884c\u4e3a\u68c0\u6d4b'],
                  ['content', '\u5185\u5bb9\u68c0\u6d4b'],
                  ['event-stream', '\u4e8b\u4ef6\u6d41'],
                  ['static', '\u9759\u6001\u626b\u63cf'],
                ]}
              />
              <SelectLike value={riskLevel} onChange={setRiskLevel} options={[['all', '\u98ce\u9669: \u5168\u90e8'], ['low', '\u4f4e'], ['medium', '\u4e2d'], ['high', '\u9ad8'], ['critical', '\u4e25\u91cd']]} />
              <SelectLike value={action} onChange={setAction} options={[['all', '\u52a8\u4f5c: \u5168\u90e8'], ['allow', '\u653e\u884c'], ['alert', '\u9884\u8b66'], ['block', '\u62e6\u622a']]} />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-black/10 dark:border-white/10">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-black/5 dark:bg-white/5">
                  <tr className="text-left">
                    <th className="px-4 py-3 font-semibold">{'\u65f6\u95f4'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u6765\u6e90'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u98ce\u9669'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u52a8\u4f5c'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u7c7b\u578b'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u6458\u8981'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u4f1a\u8bdd'}</th>
                    <th className="px-4 py-3 font-semibold">{'\u64cd\u4f5c'}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.items.map((row) => (
                    <tr key={row.id} className="border-t border-black/10 dark:border-white/10">
                      <td className="whitespace-nowrap px-4 py-3">{formatTime(row.createdAt)}</td>
                      <td className="px-4 py-3 text-xs">{sourceLabel(row.source)}</td>
                      <td className="px-4 py-3"><Badge className={cn('border', riskBadgeClass(row.riskLevel))}>{riskLevelLabel(row.riskLevel)}</Badge></td>
                      <td className="px-4 py-3">
                        <Badge
                          variant={row.action === 'block' ? 'destructive' : 'secondary'}
                          className={row.action === 'alert' ? 'border-amber-500/20 bg-amber-500/15 text-amber-700' : undefined}
                        >
                          {actionLabel(row.action)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">{riskTypeLabel(row.riskType)}</td>
                      <td className="max-w-[320px] truncate px-4 py-3">{row.summary}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.sessionKey || '-'} / {row.runId || '-'}</td>
                      <td className="px-4 py-3"><Button variant="outline" size="sm" onClick={() => setSelected(row)}>{'\u67e5\u770b\u8be6\u60c5'}</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {events.items.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">{loading ? '\u52a0\u8f7d\u4e2d...' : '\u6ca1\u6709\u5339\u914d\u7684\u5ba1\u8ba1\u8bb0\u5f55'}</div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">{`\u5171 ${formatNumber(events.total)} \u6761\uff0c\u5f53\u524d\u7b2c ${safePage}/${totalPages} \u9875`}</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1 || loading} className="rounded-full px-4">{'\u4e0a\u4e00\u9875'}</Button>
              <Button variant="outline" size="sm" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages || loading} className="rounded-full px-4">{'\u4e0b\u4e00\u9875'}</Button>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="flex w-full flex-col border-l border-black/10 p-0 dark:border-white/10 sm:max-w-[540px]">
          <div className="flex items-start justify-between border-b border-black/10 px-6 py-5 dark:border-white/10">
            <div>
              <h3 className="text-xl font-semibold">{'\u5ba1\u8ba1\u8be6\u60c5'}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{selected?.id}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
          </div>
          {selected && (
            <div className="space-y-4 overflow-y-auto p-6">
              <div className="rounded-xl border border-black/10 bg-black/5 p-3 dark:border-white/10 dark:bg-white/5">
                <p className="text-xs text-muted-foreground">{'\u98ce\u9669\u7ed3\u8bba'}</p>
                <p className="mt-1 text-sm">{`${riskTypeLabel(selected.riskType)} / ${riskLevelLabel(selected.riskLevel)} / ${actionLabel(selected.action)}`}</p>
                <p className="mt-2 text-xs text-muted-foreground">{selected.summary || '\u65e0\u6458\u8981'}</p>
              </div>

              <div>
                <p className="mb-2 text-xs text-muted-foreground">{'\u5224\u5b9a\u8bc1\u636e'}</p>
                <div className="space-y-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
                  <InfoLine label={'\u8bc1\u636e\u6765\u6e90'} value={evidenceSourceLabel(selected.detail?.evidence?.sourceType)} mono />
                  <InfoLine label={'\u89c4\u5219 ID'} value={evidenceValue(selected.detail?.evidence?.ruleId || selected.ruleId)} mono />
                  <InfoLine label={'\u5224\u5b9a\u539f\u56e0'} value={reasonLabel(selected.detail?.evidence?.reason)} />
                  <InfoLine label={'\u7f6e\u4fe1\u5ea6'} value={confidenceLabel(selected.detail?.evidence?.confidence)} mono />
                  <InfoLine label={'\u547d\u4e2d\u7247\u6bb5'} value={evidenceValue(selected.detail?.evidence?.matchedText)} />
                  <InfoLine label={'\u98ce\u9669\u5185\u5bb9'} value={evidenceValue(selected.detail?.evidence?.riskContent)} />
                </div>
              </div>

              <InfoLine label={'\u65f6\u95f4'} value={formatTime(selected.createdAt)} />
              <InfoLine label={'\u6765\u6e90'} value={sourceLabel(selected.source)} />
              <InfoLine label={'\u89c4\u5219 ID'} value={selected.ruleId || '-'} mono />
              <InfoLine label="Session" value={selected.sessionKey || '-'} mono />
              <InfoLine label="Run" value={selected.runId || '-'} mono />

              <div>
                <p className="mb-2 text-xs text-muted-foreground">{'\u89e6\u53d1\u94fe\u8def'}</p>
                <div className="space-y-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
                  <ContextTextBlock
                    label={'\u7528\u6237\u6307\u4ee4'}
                    value={normalizeInstruction(selected.detail?.context?.userInstruction)}
                  />
                  <div className="flex justify-end">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-full px-3 text-[11px]"
                      onClick={async () => {
                        await navigator.clipboard.writeText(normalizeInstruction(selected.detail?.context?.userInstruction));
                        setCopied('instruction');
                      }}
                    >
                      <Copy className="mr-1 h-3 w-3" />
                      {copied === 'instruction' ? '\u5df2\u590d\u5236' : '\u590d\u5236\u6307\u4ee4'}
                    </Button>
                  </div>
                  <InfoLine label="Step Seq" value={contextValue(selected.detail?.context?.stepSeq)} mono />
                  <InfoLine label="Tool Call ID" value={contextValue(selected.detail?.context?.toolCallId)} mono />
                  <InfoLine label={'\u89e6\u53d1\u5de5\u5177'} value={contextValue(selected.detail?.context?.triggerTool)} mono />
                  <InfoLine label="Hook Type" value={contextValue(selected.detail?.context?.hookType)} mono />
                  <InfoLine label={'\u5de5\u5177\u53c2\u6570\u6458\u8981'} value={contextValue(selected.detail?.context?.triggerParams)} mono />
                  <InfoLine
                    label={'\u6700\u8fd1\u7528\u6237\u6d88\u606f'}
                    value={selected.detail?.context?.recentUserMessages?.length ? selected.detail.context.recentUserMessages.join('\n\n') : '\u672a\u91c7\u96c6'}
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{'\u539f\u59cb\u6570\u636e'}</p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-full px-3 text-[11px]"
                      onClick={async () => {
                        await navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
                        setCopied('raw');
                      }}
                    >
                      <Copy className="mr-1 h-3 w-3" />
                      {copied === 'raw' ? '\u5df2\u590d\u5236' : '\u590d\u5236'}
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 rounded-full px-3 text-[11px]" onClick={() => setRawExpanded((v) => !v)}>
                      {rawExpanded ? <ChevronUp className="mr-1 h-3 w-3" /> : <ChevronDown className="mr-1 h-3 w-3" />}
                      {rawExpanded ? '\u6536\u8d77' : '\u5c55\u5f00'}
                    </Button>
                  </div>
                </div>
                {rawExpanded && (
                  <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap break-all rounded-xl border border-black/10 bg-black/5 p-3 text-xs dark:border-white/10 dark:bg-white/5">
                    {JSON.stringify(selected, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

    </div>
  );
}

function MetricCard({ title, value, icon }: { title: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-black/10 bg-black/5 p-4 dark:border-white/10 dark:bg-white/5">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{title}</p>
        <div>{icon}</div>
      </div>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function TimelineBars({ points, maxValue }: { points: TimelinePoint[]; maxValue: number }) {
  if (points.length === 0) {
    return <div className="flex h-52 items-center justify-center rounded-xl border border-dashed border-black/10 bg-black/5 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">{'\u6682\u65e0\u8d8b\u52bf\u6570\u636e'}</div>;
  }
  return (
    <div className="space-y-3">
      {points.slice(-7).map((point) => (
        <div key={point.bucket} className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{point.bucket}</span><span>{point.total}</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/5"><div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.max((point.total / maxValue) * 100, 3)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function SourceSummary({ rows }: { rows: AuditRow[] }) {
  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((row) => { counts[row.source] = (counts[row.source] || 0) + 1; });
    const total = rows.length || 1;
    return (Object.entries(counts) as Array<[SourceType, number]>).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count, pct: (count / total) * 100 }));
  }, [rows]);

  if (summary.length === 0) {
    return <div className="flex h-52 items-center justify-center rounded-xl border border-dashed border-black/10 bg-black/5 text-sm text-muted-foreground dark:border-white/10 dark:bg-white/5">{'\u6682\u65e0\u6765\u6e90\u6570\u636e'}</div>;
  }

  return (
    <div className="space-y-3">
      {summary.map((item) => (
        <div key={item.key} className="space-y-1">
          <div className="flex items-center justify-between text-xs"><span>{sourceLabel(item.key)}</span><span>{item.count} ({item.pct.toFixed(1)}%)</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-black/5 dark:bg-white/5"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${item.pct}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

function TopList({ title, items }: { title: string; items: Array<[string, number]> }) {
  return (
    <div className="rounded-2xl border border-black/10 p-5 dark:border-white/10">
      <h2 className="mb-4 text-xl font-semibold">{title}</h2>
      <div className="space-y-2">
        {items.length === 0 && <div className="rounded-lg bg-black/5 px-3 py-3 text-sm text-muted-foreground dark:bg-white/5">{'\u6682\u65e0\u6570\u636e'}</div>}
        {items.map(([name, value]) => (
          <div key={name} className="flex items-center justify-between rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5"><span className="font-mono text-xs">{name}</span><span className="font-semibold">{value}</span></div>
        ))}
      </div>
    </div>
  );
}

function SelectLike<T extends string>({ value, onChange, options, icon }: { value: T; onChange: (value: T) => void; options: Array<[T, string]>; icon?: ReactNode; }) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="h-10 rounded-lg border border-black/10 bg-background px-3 text-sm dark:border-white/10">
        {options.map(([v, label]) => (<option key={v} value={v}>{label}</option>))}
      </select>
    </div>
  );
}

function InfoLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <p className={cn('min-w-0 whitespace-pre-wrap break-all text-sm', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

function ContextTextBlock({ label, value }: { label: string; value: string; }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <div className="overflow-hidden rounded-lg bg-black/5 p-2 dark:bg-white/5">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-sm">{value}</pre>
      </div>
    </div>
  );
}

export default Audit;
