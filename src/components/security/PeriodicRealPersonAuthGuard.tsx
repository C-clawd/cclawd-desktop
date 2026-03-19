import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { hostApiFetch } from '@/lib/host-api';
import { useSettingsStore } from '@/stores/settings';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import cclawdIcon from '@/assets/logo.png';

type PeriodicAuthStateResponse = {
  success?: boolean;
  enabled?: boolean;
  intervalMs?: number;
  lastVerifiedAt?: number;
  locked?: boolean;
  error?: string;
};

type RealPersonAuthStartResponse = {
  success?: boolean;
  apiKey?: string;
  certToken?: string;
  qrCodeUrl?: string;
  qrCodeDataUrl?: string;
  error?: string;
};

type RealPersonAuthCheckResponse = {
  success?: boolean;
  status?: 'pending' | 'success' | 'failed';
  message?: string;
  retCode?: number;
  error?: string;
};

type RealPersonAuthSession = {
  apiKey: string;
  certToken: string;
  qrCodeUrl: string;
  qrCodeDataUrl: string;
};

export function PeriodicRealPersonAuthGuard() {
  const { t } = useTranslation('setup');
  const location = useLocation();
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [session, setSession] = useState<RealPersonAuthSession | null>(null);
  const [qrVisible, setQrVisible] = useState(false);
  const pollTimerRef = useRef<number | null>(null);
  const evaluateTimerRef = useRef<number | null>(null);
  const openRef = useRef(false);
  const lockRequestedRef = useRef(false);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
    }
    if (evaluateTimerRef.current !== null) {
      window.clearTimeout(evaluateTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!setupComplete || location.pathname.startsWith('/setup')) return;

    let disposed = false;

    const clearEvaluateTimer = () => {
      if (evaluateTimerRef.current !== null) {
        window.clearTimeout(evaluateTimerRef.current);
        evaluateTimerRef.current = null;
      }
    };

    const scheduleEvaluation = (delayMs: number) => {
      clearEvaluateTimer();
      evaluateTimerRef.current = window.setTimeout(() => {
        void evaluateState();
      }, Math.max(500, delayMs));
    };

    const evaluateState = async () => {
      if (disposed || openRef.current) return;

      try {
        const response = await hostApiFetch<PeriodicAuthStateResponse>('/api/app/periodic-auth/state');
        if (disposed || response?.success === false) {
          throw new Error(response?.error || 'Failed to load periodic auth state');
        }

        const enabled = response.enabled !== false;
        const intervalMs = Math.max(1_000, response.intervalMs || 24 * 60 * 60 * 1000);
        const lastVerifiedAt = response.lastVerifiedAt || 0;
        const locked = response.locked === true;
        const due = locked || lastVerifiedAt <= 0 || (Date.now() - lastVerifiedAt) >= intervalMs;

        if (!enabled) {
          setOpen(false);
          lockRequestedRef.current = false;
          return;
        }

        if (due) {
          if (!lockRequestedRef.current) {
            lockRequestedRef.current = true;
            await hostApiFetch('/api/app/periodic-auth/lock', { method: 'POST' });
          }
          if (!disposed) {
            setOpen(true);
            setQrVisible(false);
            setErrorMessage(null);
            setStatusMessage(null);
            setSession(null);
          }
          return;
        }

        const remainingMs = intervalMs - (Date.now() - lastVerifiedAt);
        scheduleEvaluation(remainingMs);
      } catch (error) {
        console.error('Failed to evaluate periodic auth state:', error);
        scheduleEvaluation(5_000);
      }
    };

    void evaluateState();

    return () => {
      disposed = true;
      clearEvaluateTimer();
    };
  }, [location.pathname, open, setupComplete]);

  const clearPollTimer = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const scheduleNextCheck = (activeSession: RealPersonAuthSession) => {
    clearPollTimer();
    pollTimerRef.current = window.setTimeout(() => {
      void (async () => {
        setChecking(true);
        try {
          const response = await hostApiFetch<RealPersonAuthCheckResponse>('/api/app/real-person-auth/check', {
            method: 'POST',
            body: JSON.stringify({
              apiKey: activeSession.apiKey,
              certToken: activeSession.certToken,
              context: 'periodic',
            }),
          });

          if (response?.success === false) {
            throw new Error(response.error || 'Failed to check verification status');
          }

          if (response.status === 'success') {
            clearPollTimer();
            lockRequestedRef.current = false;
            setChecking(false);
            setOpen(false);
            setSession(null);
            setQrVisible(false);
            setErrorMessage(null);
            setStatusMessage(response.message || t('realPerson.success.default'));
            toast.success(t('realPerson.saved'));
            return;
          }

          if (response.status === 'pending') {
            setErrorMessage(null);
            setStatusMessage(response.message || t('realPerson.pending'));
            scheduleNextCheck(activeSession);
            return;
          }

          clearPollTimer();
          setChecking(false);
          setErrorMessage(response.message || t('realPerson.statusFailed'));
          setStatusMessage(null);
        } catch (error) {
          clearPollTimer();
          setChecking(false);
          setErrorMessage(String(error));
          setStatusMessage(null);
        }
      })();
    }, 2_000);
  };

  const handleStart = async () => {
    clearPollTimer();
    setStarting(true);
    setChecking(false);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      const response = await hostApiFetch<RealPersonAuthStartResponse>('/api/app/real-person-auth/start-from-saved-key', {
        method: 'POST',
      });

      if (response?.success === false) {
        throw new Error(response.error || 'Failed to start verification');
      }

      if (!response.apiKey || !response.certToken || !response.qrCodeUrl || !response.qrCodeDataUrl) {
        throw new Error(t('realPerson.startFailed'));
      }

      const nextSession: RealPersonAuthSession = {
        apiKey: response.apiKey,
        certToken: response.certToken,
        qrCodeUrl: response.qrCodeUrl,
        qrCodeDataUrl: response.qrCodeDataUrl,
      };

      setSession(nextSession);
      setQrVisible(true);
      setChecking(true);
      setStatusMessage(t('realPerson.pending'));
      scheduleNextCheck(nextSession);
    } catch (error) {
      setSession(null);
      setQrVisible(false);
      setErrorMessage(String(error));
      toast.error(t('realPerson.startFailed'));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!open || session || starting || checking) return;
    void handleStart();
  }, [checking, open, session, starting]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/75 px-4 py-8 backdrop-blur-sm">
      <div
        className="w-full max-w-xl rounded-3xl border border-white/10 bg-background p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="periodic-auth-title"
      >
        <div className="mb-6 flex items-start gap-4">
          <div className="flex h-12 w-12 items-center justify-center p-2">
            <img src={cclawdIcon} alt="Cclawd" className="h-8 w-8 object-contain" />
          </div>
          <div className="space-y-2">
            <h2 id="periodic-auth-title" className="text-xl font-semibold">
              {t('realPerson.title')}
            </h2>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-3 text-center">
            <h3 className="text-lg font-semibold">{t('realPerson.qr.title')}</h3>
            <p className="text-sm text-muted-foreground">
              {checking ? t('realPerson.qr.subtitleChecking') : t('realPerson.qr.subtitle')}
            </p>
          </div>

          <div
            className={cn(
              'mx-auto flex min-h-[320px] max-w-[320px] items-center justify-center rounded-3xl border border-dashed border-border/70 p-4',
              qrVisible ? 'bg-white/95' : 'bg-muted/30'
            )}
          >
            {session?.qrCodeDataUrl ? (
              <img
                src={session.qrCodeDataUrl}
                alt={t('realPerson.qr.alt')}
                className="h-64 w-64 rounded-2xl object-contain"
              />
            ) : (
              <div className="space-y-3 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                <p>{t('realPerson.qr.scanHint')}</p>
              </div>
            )}
          </div>

          <p className="text-center text-sm text-muted-foreground">{t('realPerson.qr.scanHint')}</p>

          {errorMessage && (
            <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3">
            <Button
              variant="outline"
              className="w-full"
              disabled={!session?.qrCodeUrl}
              onClick={() => {
                if (!session?.qrCodeUrl) return;
                void window.electron.ipcRenderer.invoke('shell:openExternal', session.qrCodeUrl);
              }}
            >
              <ExternalLink className="mr-2 h-4 w-4" />
              {t('realPerson.qr.open')}
            </Button>

            <Button onClick={handleStart} disabled={starting} className="w-full">
              {starting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t('realPerson.refreshQr')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
