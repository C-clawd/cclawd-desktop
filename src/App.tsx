/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Component, useEffect, useMemo, useState } from 'react';
import type { ErrorInfo, FormEvent, ReactNode } from 'react';
import { Toaster } from 'sonner';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Models } from './pages/Models';
import { Chat } from './pages/Chat';
import { Agents } from './pages/Agents';
import { Channels } from './pages/Channels';
import { Skills } from './pages/Skills';
import { Cron } from './pages/Cron';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Trial } from './pages/Trial';
import { Audit } from './pages/Audit';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useProviderStore } from './stores/providers';
import { applyGatewayTransportPreference } from './lib/api-client';
import { PeriodicRealPersonAuthGuard } from './components/security/PeriodicRealPersonAuthGuard';
import { isTrialExpired } from '../shared/trial';
import { hostApiFetch } from './lib/host-api';

type GuardEntitlementResponse = {
  success?: boolean;
  data?: {
    allowed?: boolean;
    reasonCode?: string;
    message?: string;
    requireRelogin?: boolean;
  };
};


/**
 * Error Boundary to catch and display React rendering errors
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: '#f87171',
          background: '#0f172a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Something went wrong</h1>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: '#1e293b',
            padding: '16px',
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const initSettings = useSettingsStore((state) => state.init);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const initialized = useSettingsStore((state) => state.initialized);
  const trialStartAt = useSettingsStore((state) => state.trialStartAt);
  const initGateway = useGatewayStore((state) => state.init);
  const initProviders = useProviderStore((state) => state.init);
  const trialExpired = initialized && isTrialExpired(trialStartAt);
  const [guardEntitlementChecked, setGuardEntitlementChecked] = useState(false);
  const [guardEntitlementAllowed, setGuardEntitlementAllowed] = useState(true);
  const [guardEntitlementMessage, setGuardEntitlementMessage] = useState('');
  const [guardRequireRelogin, setGuardRequireRelogin] = useState(false);
  const [guardEntitlementRefreshKey, setGuardEntitlementRefreshKey] = useState(0);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    if (!initialized || trialExpired) return;
    initGateway();
  }, [initGateway, initialized, trialExpired]);

  // Initialize provider snapshot on mount
  useEffect(() => {
    if (!initialized || trialExpired) return;
    initProviders();
  }, [initProviders, initialized, trialExpired]);

  // Redirect to setup wizard or trial lock screen when appropriate.
  useEffect(() => {
    if (!initialized) return;
    if (trialExpired && location.pathname !== '/trial') {
      navigate('/trial');
      return;
    }
    if (trialExpired) return;
    if (!setupComplete && !location.pathname.startsWith('/setup')) {
      navigate('/setup');
    }
  }, [initialized, location.pathname, navigate, setupComplete, trialExpired]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = window.electron.ipcRenderer.on('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply theme - force light mode only
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add('light');
  }, []);

  useEffect(() => {
    applyGatewayTransportPreference();
  }, []);

  useEffect(() => {
    if (!initialized || trialExpired || !setupComplete) {
      setGuardEntitlementChecked(false);
      setGuardEntitlementAllowed(true);
      setGuardEntitlementMessage('');
      setGuardRequireRelogin(false);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const response = await hostApiFetch<GuardEntitlementResponse>('/api/audit/entitlement');
        if (cancelled) return;
        const allowed = Boolean(response?.success) && response?.data?.allowed !== false;
        setGuardEntitlementAllowed(allowed);
        setGuardEntitlementMessage(allowed ? '' : (response?.data?.message || '企业权限校验未通过'));
        setGuardRequireRelogin(Boolean(response?.data?.requireRelogin));
      } catch {
        if (cancelled) return;
        // Keep app usable on transient check failures.
        setGuardEntitlementAllowed(true);
        setGuardEntitlementMessage('');
        setGuardRequireRelogin(false);
      } finally {
        if (!cancelled) {
          setGuardEntitlementChecked(true);
        }
      }
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [initialized, setupComplete, trialExpired, guardEntitlementRefreshKey]);

  const guardBlocked = useMemo(
    () => initialized && setupComplete && !trialExpired && guardEntitlementChecked && !guardEntitlementAllowed,
    [initialized, setupComplete, trialExpired, guardEntitlementChecked, guardEntitlementAllowed],
  );
  const guardReloginBlocked = useMemo(
    () => guardBlocked && guardRequireRelogin,
    [guardBlocked, guardRequireRelogin],
  );

  useEffect(() => {
    if (!guardReloginBlocked) return;
    if (location.pathname === '/org-login') return;
    navigate('/org-login');
  }, [guardReloginBlocked, location.pathname, navigate]);

  const handleRelogin = async () => {
    try {
      await hostApiFetch('/api/audit/relogin', { method: 'POST' });
    } catch {
      // Best effort only.
    } finally {
      navigate('/org-login');
    }
  };

  const handleOrgLoginSuccess = async (): Promise<{ ok: boolean; message?: string }> => {
    try {
      const response = await hostApiFetch<GuardEntitlementResponse>('/api/audit/entitlement');
      const allowed = Boolean(response?.success) && response?.data?.allowed !== false;
      setGuardEntitlementChecked(true);
      setGuardEntitlementAllowed(allowed);
      setGuardEntitlementMessage(allowed ? '' : (response?.data?.message || '企业权限校验未通过'));
      setGuardRequireRelogin(Boolean(response?.data?.requireRelogin));
      if (!allowed) {
        return {
          ok: false,
          message: response?.data?.message || '登录成功，但当前账号仍未通过企业权限校验',
        };
      }
    } catch {
      return { ok: false, message: '登录成功，但权限校验失败，请稍后重试' };
    }

    setGuardEntitlementChecked(false);
    setGuardEntitlementAllowed(true);
    setGuardEntitlementMessage('');
    setGuardRequireRelogin(false);
    setGuardEntitlementRefreshKey((current) => current + 1);
    navigate('/');
    return { ok: true };
  };

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        {trialExpired ? (
          <Routes>
            <Route path="/trial" element={<Trial />} />
            <Route path="*" element={<Trial />} />
          </Routes>
        ) : (
          <>
            <Routes>
              {/* Setup wizard (shown on first launch) */}
              <Route path="/setup/*" element={<Setup />} />
              <Route path="/org-login" element={<OrgLoginPage message={guardEntitlementMessage} onLoginSuccess={handleOrgLoginSuccess} />} />

              {/* Main application routes */}
              <Route element={<MainLayout />}>
                {guardReloginBlocked ? (
                  <Route path="*" element={<GuardReloginLocked message={guardEntitlementMessage} onRelogin={handleRelogin} />} />
                ) : guardBlocked ? (
                  <>
                    <Route path="/settings/*" element={<Settings />} />
                    <Route path="*" element={<GuardEntitlementLocked message={guardEntitlementMessage} />} />
                  </>
                ) : (
                  <>
                    <Route path="/settings/*" element={<Settings />} />
                    <Route path="/" element={<Chat />} />
                    <Route path="/models" element={<Models />} />
                    <Route path="/agents" element={<Agents />} />
                    <Route path="/channels" element={<Channels />} />
                    <Route path="/skills" element={<Skills />} />
                    <Route path="/cron" element={<Cron />} />
                    <Route path="/audit" element={<Audit />} />
                    <Route path="/trial" element={<Trial />} />
                  </>
                )}
              </Route>
            </Routes>

            <PeriodicRealPersonAuthGuard />
          </>
        )}

        {/* Global toast notifications */}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          style={{ zIndex: 99999 }}
        />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function GuardEntitlementLocked({ message }: { message: string }) {
  const displayMessage = message || '当前账号未通过企业权限校验，主功能已受限';
  return (
    <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-red-500/20 bg-red-500/5 p-8">
      <h2 className="text-2xl font-semibold text-red-600">企业权限受限</h2>
      <p className="mt-3 text-sm text-foreground/80">{displayMessage}</p>
      <p className="mt-2 text-xs text-foreground/60">请联系管理员处理订阅/席位/账号状态后重试。你仍可进入“设置”页面修改组织鉴权配置。</p>
    </div>
  );
}

function GuardReloginLocked({ message, onRelogin }: { message: string; onRelogin: () => void }) {
  const displayMessage = message || '当前组织账号不可用，已强制退出主功能';
  return (
    <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-red-500/20 bg-red-500/5 p-8">
      <h2 className="text-2xl font-semibold text-red-600">需要重新登录</h2>
      <p className="mt-3 text-sm text-foreground/80">{displayMessage}</p>
      <p className="mt-2 text-xs text-foreground/60">请重新登录后再继续使用 Cclawd Desktop。</p>
      <button
        type="button"
        onClick={onRelogin}
        className="mt-6 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
      >
        重新登录
      </button>
    </div>
  );
}

function OrgLoginPage({ message, onLoginSuccess }: { message: string; onLoginSuccess: () => Promise<{ ok: boolean; message?: string }> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const displayMessage = message || '当前组织账号不可用，请重新登录';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setErrorMessage('');
    setSubmitting(true);
    try {
      const response = await hostApiFetch<{ success?: boolean; error?: string }>('/api/audit/org-login', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim(),
          password,
        }),
      });
      if (!response?.success) {
        throw new Error(response?.error || '登录失败，请检查账号和密码');
      }
      const result = await onLoginSuccess();
      if (!result.ok) {
        setErrorMessage(result.message || '登录成功，但当前账号仍不可用');
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-48px)] items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-sky-200/70 bg-card/95 p-8 shadow-sm">
        <h2 className="text-2xl font-semibold text-sky-600">企业账号重新登录</h2>
        <p className="mt-3 text-sm text-foreground/80">{displayMessage}</p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1 block text-sm text-foreground/70" htmlFor="org-login-email">邮箱</label>
            <input
              id="org-login-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              className="w-full rounded-md border border-sky-200 bg-background px-3 py-2 text-sm outline-none focus:border-sky-400"
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-foreground/70" htmlFor="org-login-password">密码</label>
            <input
              id="org-login-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              className="w-full rounded-md border border-sky-200 bg-background px-3 py-2 text-sm outline-none focus:border-sky-400"
              required
            />
          </div>
          {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {submitting ? '登录中...' : '登录并继续'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;
