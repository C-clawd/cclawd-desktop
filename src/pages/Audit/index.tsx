import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
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
type ActionType = 'allow' | 'block';
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
};

type ApiResponse<T> = {
  success: boolean;
  data: T;
  error?: string;
};

type AuditEventsData = {
  total: number;
  items: AuditRow[];
};

function riskBadgeClass(level: RiskLevel): string {
  if (level === 'critical') return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20';
  if (level === 'high') return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20';
  if (level === 'medium') return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20';
  if (level === 'safe') return 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20';
  return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20';
}

function sourceLabel(source: SourceType): string {
  const labels: Record<SourceType, string> = {
    behavior: '行为检测',
    content: '内容检测',
    'event-stream': '事件流',
    static: '静态扫描',
  };
  return labels[source] ?? source;
}

function riskLevelLabel(level: RiskLevel): string {
  const labels: Record<RiskLevel, string> = {
    low: '低',
    medium: '中',
    high: '高',
    critical: '严重',
    safe: '安全',
  };
  return labels[level] ?? level;
}

function actionLabel(action: ActionType): string {
  return action === 'block' ? '拦截' : '放行';
}

function riskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    DATA_EXFILTRATION: '数据外传',
    PROMPT_INJECTION: '提示注入',
    COMMAND_EXECUTION: '命令执行',
    CONTENT_SCAN: '内容扫描',
    STATIC_SCAN: '静态扫描',
    EVENT_STREAM_RULE: '事件流规则',
    SECRET_LEAK: '密钥泄露',
    PII_EXPOSURE: '隐私暴露',
    UNKNOWN: '未知',
  };
  return labels[type] ?? type;
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

export function Audit() {
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | SourceType>('all');
  const [riskLevel, setRiskLevel] = useState<'all' | RiskLevel>('all');
  const [action, setAction] = useState<'all' | ActionType>('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AuditRow | null>(null);
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
          .map((item) => `${item.name}: ${item.resp?.error || 'unknown error'}`)
          .join('; ');
        throw new Error(`审计接口返回失败 (${details})`);
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
    void loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, source, riskLevel, action, search, safePage]);

  return (
    <div className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-6xl mx-auto flex flex-col h-full p-10 pt-16">
        <div className="flex flex-col md:flex-row md:items-start justify-between mb-8 shrink-0 gap-4">
          <div>
            <h1
              className="text-5xl md:text-6xl font-serif text-foreground mb-3 font-normal tracking-tight"
              style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}
            >
              审计
            </h1>
            <p className="text-[17px] text-foreground/70 font-medium">
              安全事件、拦截趋势与审计明细
            </p>
          </div>
          <div className="flex items-center gap-2 md:mt-2">
            {(['24h', '7d', '30d'] as WindowKey[]).map((key) => (
              <Button
                key={key}
                variant={windowKey === key ? 'secondary' : 'outline'}
                className={cn(
                  'h-9 rounded-full px-4 text-[13px]',
                  windowKey === key
                    ? 'bg-black/10 dark:bg-white/10'
                    : 'border-black/10 dark:border-white/10 bg-transparent',
                )}
                onClick={() => setWindowKey(key)}
              >
                {key}
              </Button>
            ))}
            <Button
              variant="outline"
              className="h-9 rounded-full px-4 text-[13px] border-black/10 dark:border-white/10 bg-transparent"
              onClick={() => void loadData()}
              disabled={loading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-2', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2 space-y-6">
          {error && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-600 dark:text-red-400">
              数据加载失败：{error}
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard title="总检测量" value={formatNumber(overview.totalEvents)} icon={<Activity className="h-5 w-5 text-blue-600" />} />
            <MetricCard title="拦截量" value={formatNumber(overview.blockedEvents)} icon={<ShieldCheck className="h-5 w-5 text-emerald-600" />} />
            <MetricCard title="高危事件" value={formatNumber(overview.highRiskEvents)} icon={<ShieldAlert className="h-5 w-5 text-orange-600" />} />
            <MetricCard title="拦截率" value={formatPercent(overview.blockRate)} icon={<ShieldCheck className="h-5 w-5 text-indigo-600" />} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-black/10 dark:border-white/10 p-5">
              <h2 className="text-xl font-semibold mb-4">风险趋势</h2>
              <TimelineBars points={timeline} maxValue={maxTimelineTotal} />
            </div>
            <div className="rounded-2xl border border-black/10 dark:border-white/10 p-5">
              <h2 className="text-xl font-semibold mb-4">来源占比</h2>
              <SourceSummary rows={events.items} />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopList title="风险类型 Top10" items={topRiskTypes.map((item) => [riskTypeLabel(item.name), item.count])} />
            <TopList title="规则命中 Top10" items={topRules.map((item) => [item.name, item.count])} />
          </div>

          <div className="rounded-2xl border border-black/10 dark:border-white/10 p-4">
            <div className="flex flex-col lg:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索 风险类型 / 摘要 / sessionKey / runId"
                  className="pl-9 h-10 border-black/10 dark:border-white/10"
                />
              </div>
              <SelectLike
                icon={<Filter className="h-4 w-4" />}
                value={source}
                onChange={setSource}
                options={[
                  ['all', '来源: 全部'],
                  ['behavior', '行为检测'],
                  ['content', '内容检测'],
                  ['event-stream', '事件流'],
                  ['static', '静态扫描'],
                ]}
              />
              <SelectLike
                value={riskLevel}
                onChange={setRiskLevel}
                options={[
                  ['all', '风险: 全部'],
                  ['low', '低'],
                  ['medium', '中'],
                  ['high', '高'],
                  ['critical', '严重'],
                ]}
              />
              <SelectLike
                value={action}
                onChange={setAction}
                options={[
                  ['all', '动作: 全部'],
                  ['allow', '放行'],
                  ['block', '拦截'],
                ]}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-black/10 dark:border-white/10 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-black/5 dark:bg-white/5">
                  <tr className="text-left">
                    <th className="px-4 py-3 font-semibold">时间</th>
                    <th className="px-4 py-3 font-semibold">来源</th>
                    <th className="px-4 py-3 font-semibold">风险</th>
                    <th className="px-4 py-3 font-semibold">动作</th>
                    <th className="px-4 py-3 font-semibold">类型</th>
                    <th className="px-4 py-3 font-semibold">摘要</th>
                    <th className="px-4 py-3 font-semibold">会话</th>
                    <th className="px-4 py-3 font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {events.items.map((row) => (
                    <tr key={row.id} className="border-t border-black/10 dark:border-white/10">
                      <td className="px-4 py-3 whitespace-nowrap">{formatTime(row.createdAt)}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs">{sourceLabel(row.source)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={cn('border', riskBadgeClass(row.riskLevel))}>{riskLevelLabel(row.riskLevel)}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={row.action === 'block' ? 'destructive' : 'secondary'}>
                          {actionLabel(row.action)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-xs">{riskTypeLabel(row.riskType)}</td>
                      <td className="px-4 py-3 max-w-[320px] truncate">{row.summary}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.sessionKey || '-'} / {row.runId || '-'}</td>
                      <td className="px-4 py-3">
                        <Button variant="outline" size="sm" onClick={() => setSelected(row)}>
                          查看详情
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {events.items.length === 0 && (
              <div className="py-10 text-center text-muted-foreground text-sm">
                {loading ? '加载中...' : '没有匹配的审计记录'}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">
              共 {formatNumber(events.total)} 条，当前第 {safePage}/{totalPages} 页
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={safePage <= 1 || loading}
                className="rounded-full px-4"
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={safePage >= totalPages || loading}
                className="rounded-full px-4"
              >
                下一页
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-[520px] p-0 flex flex-col border-l border-black/10 dark:border-white/10"
        >
          <div className="px-6 py-5 border-b border-black/10 dark:border-white/10 flex items-start justify-between">
            <div>
              <h3 className="text-xl font-semibold">审计详情</h3>
              <p className="text-sm text-muted-foreground mt-1">{selected?.id}</p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSelected(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {selected && (
            <div className="p-6 space-y-4 overflow-y-auto">
              <InfoLine label="时间" value={formatTime(selected.createdAt)} />
              <InfoLine label="来源" value={sourceLabel(selected.source)} />
              <InfoLine label="风险等级" value={riskLevelLabel(selected.riskLevel)} />
              <InfoLine label="动作" value={actionLabel(selected.action)} />
              <InfoLine label="风险类型" value={riskTypeLabel(selected.riskType)} />
              <InfoLine label="规则 ID" value={selected.ruleId || '-'} mono />
              <InfoLine label="Session" value={selected.sessionKey || '-'} mono />
              <InfoLine label="Run" value={selected.runId || '-'} mono />
              <div>
                <p className="text-xs text-muted-foreground mb-2">摘要</p>
                <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-sm">
                  {selected.summary || '-'}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-2">原始数据</p>
                <pre className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-xs overflow-auto bg-black/5 dark:bg-white/5">
{JSON.stringify(selected, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function MetricCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="p-4 rounded-2xl bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">{title}</p>
        <div>{icon}</div>
      </div>
      <p className="text-2xl font-semibold mt-2">{value}</p>
    </div>
  );
}

function TimelineBars({ points, maxValue }: { points: TimelinePoint[]; maxValue: number }) {
  if (points.length === 0) {
    return (
      <div className="h-52 rounded-xl bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 flex items-center justify-center text-sm text-muted-foreground">
        暂无趋势数据
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {points.slice(-7).map((point) => (
        <div key={point.bucket} className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{point.bucket}</span>
            <span>{point.total}</span>
          </div>
          <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full"
              style={{ width: `${Math.max((point.total / maxValue) * 100, 3)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceSummary({ rows }: { rows: AuditRow[] }) {
  const summary = useMemo(() => {
    const counts: Record<string, number> = {};
    rows.forEach((row) => {
      counts[row.source] = (counts[row.source] || 0) + 1;
    });
    const total = rows.length || 1;
    return (Object.entries(counts) as Array<[SourceType, number]>)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count, pct: (count / total) * 100 }));
  }, [rows]);

  if (summary.length === 0) {
    return (
      <div className="h-52 rounded-xl bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 flex items-center justify-center text-sm text-muted-foreground">
        暂无来源数据
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {summary.map((item) => (
        <div key={item.key} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span>{sourceLabel(item.key)}</span>
            <span>{item.count} ({item.pct.toFixed(1)}%)</span>
          </div>
          <div className="h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${item.pct}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function TopList({ title, items }: { title: string; items: Array<[string, number]> }) {
  return (
    <div className="rounded-2xl border border-black/10 dark:border-white/10 p-5">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <div className="space-y-2">
        {items.length === 0 && (
          <div className="rounded-lg px-3 py-3 bg-black/5 dark:bg-white/5 text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
        {items.map(([name, value]) => (
          <div key={name} className="flex items-center justify-between rounded-lg px-3 py-2 bg-black/5 dark:bg-white/5">
            <span className="font-mono text-xs">{name}</span>
            <span className="font-semibold">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SelectLike<T extends string>({
  value,
  onChange,
  options,
  icon,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<[T, string]>;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-10 rounded-lg border border-black/10 dark:border-white/10 bg-background px-3 text-sm"
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
    </div>
  );
}

function InfoLine({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn('text-sm', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

export default Audit;
