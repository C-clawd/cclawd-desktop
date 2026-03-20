import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSettingsStore } from '@/stores/settings';

export function Trial() {
  const { t } = useTranslation('common');
  const trialStartAt = useSettingsStore((state) => state.trialStartAt);
  const nowMs = Date.now();
  const totalDays = 30;

  const remainingDays = useMemo(() => {
    if (!trialStartAt) return totalDays;
    const daysElapsed = Math.floor((nowMs - trialStartAt) / (24 * 60 * 60 * 1000));
    return Math.max(0, totalDays - daysElapsed);
  }, [nowMs, trialStartAt]);

  const startDate = useMemo(() => (
    trialStartAt ? new Date(trialStartAt).toLocaleDateString() : '—'
  ), [trialStartAt]);
  const endDate = useMemo(() => (
    trialStartAt ? new Date(trialStartAt + totalDays * 24 * 60 * 60 * 1000).toLocaleDateString() : '—'
  ), [trialStartAt]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-10 pt-10">
        <h1 className="text-3xl font-semibold">{t('trial.title')}</h1>
      </div>

      <div className="px-10 py-8">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="text-xl">{t('trial.title')}</CardTitle>
            <CardDescription>{t('trial.remaining', { days: remainingDays })}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>{t('trial.start', { date: startDate })}</div>
            <div>{t('trial.end', { date: endDate })}</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default Trial;
