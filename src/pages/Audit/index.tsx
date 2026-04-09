import { useMemo, useState } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  Activity,
  RefreshCw,
  Search,
  Filter,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

type WindowKey = '24h' | '7d' | '30d';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ActionType = 'allow' | 'block';
type SourceType = 'behavior' | 'content' | 'event-stream' | 'static';

type AuditRow = {
  id: string;
  time: string;
  source: SourceType;
  riskLevel: RiskLevel;
  action: ActionType;
  riskType: string;
  summary: string;
  sessionKey: string;
  runId: string;
};

const MOCK_ROWS: AuditRow[] = [
  {
    id: 'evt-001',
    time: '13:01:24',
    source: 'event-stream',
    riskLevel: 'high',
    action: 'block',
    riskType: 'DATA_EXFILTRATION',
    summary: '检测到可疑外传指令，已阻断',
    sessionKey: 's-9f1',
    runId: 'r-201',
  },
  {
    id: 'evt-002',
    time: '12:58:09',
    source: 'behavior',
    riskLevel: 'critical',
    action: 'block',
    riskType: 'COMMAND_EXECUTION',
    summary: '检测到高危命令执行模式',
    sessionKey: 's-7ac',
    runId: 'r-198',
  },
  {
    id: 'evt-003',
    time: '12:41:33',
    source: 'content',
    riskLevel: 'medium',
    action: 'allow',
    riskType: 'PROMPT_INJECTION',
    summary: '疑似提示注入，建议复核',
    sessionKey: 's-5be',
    runId: 'r-193',
  },
  {
    id: 'evt-004',
    time: '12:16:10',
    source: 'static',
    riskLevel: 'high',
    action: 'block',
    riskType: 'SECRET_LEAK',
    summary: '代码扫描命中疑似密钥',
    sessionKey: 's-2d9',
    runId: 'r-188',
  },
  {
    id: 'evt-005',
    time: '11:52:47',
    source: 'content',
    riskLevel: 'low',
    action: 'allow',
    riskType: 'PII_EXPOSURE',
    summary: '发现低置信度敏感字段',
    sessionKey: 's-31c',
    runId: 'r-180',
  },
];

function riskBadgeClass(level: RiskLevel): string {
  if (level === 'critical') return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20';
  if (level === 'high') return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20';
  if (level === 'medium') return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20';
  return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20';
}

function sourceLabel(source: SourceType): string {
  if (source === 'behavior') return '行为检测';
  if (source === 'content') return '内容检测';
  if (source === 'event-stream') return '事件流';
  return '静态扫描';
}

function riskLevelLabel(level: RiskLevel): string {
  if (level === 'critical') return '严重';
  if (level === 'high') return '高';
  if (level === 'medium') return '中';
  return '低';
}

function actionLabel(action: ActionType): string {
  return action === 'block' ? '拦截' : '放行';
}

function riskTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    DATA_EXFILTRATION: '数据外传',
    PROMPT_INJECTION: '提示注入',
    COMMAND_EXECUTION: '命令执行',
    SECRET_LEAK: '密钥泄露',
    PII_EXPOSURE: '隐私暴露',
  };
  return labels[type] ?? type;
}

export function Audit() {
  const [windowKey, setWindowKey] = useState<WindowKey>('7d');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | SourceType>('all');
  const [riskLevel, setRiskLevel] = useState<'all' | RiskLevel>('all');
  const [action, setAction] = useState<'all' | ActionType>('all');
  const [selected, setSelected] = useState<AuditRow | null>(null);

  const filteredRows = useMemo(() => {
    return MOCK_ROWS.filter((row) => {
      if (source !== 'all' && row.source !== source) return false;
      if (riskLevel !== 'all' && row.riskLevel !== riskLevel) return false;
      if (action !== 'all' && row.action !== action) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        row.riskType.toLowerCase().includes(q)
        || row.summary.toLowerCase().includes(q)
        || row.sessionKey.toLowerCase().includes(q)
        || row.runId.toLowerCase().includes(q)
      );
    });
  }, [search, source, riskLevel, action]);

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
              安全事件、拦截趋势与审计明细（当前为页面预览数据）
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
                    : 'border-black/10 dark:border-white/10 bg-transparent'
                )}
                onClick={() => setWindowKey(key)}
              >
                {key}
              </Button>
            ))}
            <Button
              variant="outline"
              className="h-9 rounded-full px-4 text-[13px] border-black/10 dark:border-white/10 bg-transparent"
            >
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              刷新
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2 space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <MetricCard title="总检测量" value="1,248" icon={<Activity className="h-5 w-5 text-blue-600" />} />
            <MetricCard title="拦截量" value="382" icon={<ShieldCheck className="h-5 w-5 text-emerald-600" />} />
            <MetricCard title="高危事件" value="97" icon={<ShieldAlert className="h-5 w-5 text-orange-600" />} />
            <MetricCard title="拦截率" value="30.6%" icon={<ShieldCheck className="h-5 w-5 text-indigo-600" />} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-black/10 dark:border-white/10 p-5">
              <h2 className="text-xl font-semibold mb-4">风险趋势</h2>
              <div className="h-52 rounded-xl bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 flex items-center justify-center text-sm text-muted-foreground">
                趋势图占位（折线/柱状）
              </div>
            </div>
            <div className="rounded-2xl border border-black/10 dark:border-white/10 p-5">
              <h2 className="text-xl font-semibold mb-4">来源占比</h2>
              <div className="h-52 rounded-xl bg-black/5 dark:bg-white/5 border border-dashed border-black/10 dark:border-white/10 flex items-center justify-center text-sm text-muted-foreground">
                环图占位
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopList
              title="风险类型 Top10"
              items={[
                ['数据外传', 43],
                ['提示注入', 28],
                ['命令执行', 17],
                ['密钥泄露', 11],
              ]}
            />
            <TopList
              title="规则命中 Top10"
              items={[
                ['PI-01', 37],
                ['SE-02', 19],
                ['RCE-01', 12],
                ['DE-01', 9],
              ]}
            />
          </div>

          <div className="rounded-2xl border border-black/10 dark:border-white/10 p-4">
            <div className="flex flex-col lg:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索 riskType / 摘要 / sessionKey / runId"
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
                  {filteredRows.map((row) => (
                    <tr key={row.id} className="border-t border-black/10 dark:border-white/10">
                      <td className="px-4 py-3">{row.time}</td>
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
                      <td className="px-4 py-3 max-w-[260px] truncate">{row.summary}</td>
                      <td className="px-4 py-3 font-mono text-xs">{row.sessionKey} / {row.runId}</td>
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
            {filteredRows.length === 0 && (
              <div className="py-10 text-center text-muted-foreground text-sm">
                没有匹配的审计记录
              </div>
            )}
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
              <p className="text-sm text-muted-foreground mt-1">
                {selected?.id}
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSelected(null)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {selected && (
            <div className="p-6 space-y-4 overflow-y-auto">
              <InfoLine label="时间" value={selected.time} />
              <InfoLine label="来源" value={sourceLabel(selected.source)} />
              <InfoLine label="风险等级" value={riskLevelLabel(selected.riskLevel)} />
              <InfoLine label="动作" value={actionLabel(selected.action)} />
              <InfoLine label="风险类型" value={riskTypeLabel(selected.riskType)} />
              <InfoLine label="Session" value={selected.sessionKey} mono />
              <InfoLine label="Run" value={selected.runId} mono />
              <div>
                <p className="text-xs text-muted-foreground mb-2">摘要</p>
                <div className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-sm">
                  {selected.summary}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-2">原始数据（预览占位）</p>
                <pre className="rounded-xl border border-black/10 dark:border-white/10 p-3 text-xs overflow-auto bg-black/5 dark:bg-white/5">
{`{
  "request": { "...": "..." },
  "findings": [ { "riskType": "${selected.riskType}" } ],
  "meta": { "previewOnly": true }
}`}
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

function TopList({ title, items }: { title: string; items: Array<[string, number]> }) {
  return (
    <div className="rounded-2xl border border-black/10 dark:border-white/10 p-5">
      <h2 className="text-xl font-semibold mb-4">{title}</h2>
      <div className="space-y-2">
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
