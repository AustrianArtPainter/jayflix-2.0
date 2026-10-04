'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, onUnauthorized, STATUS_QUERY_KEY } from '@/lib/client-api';
import { applyEnvPresets } from '@/lib/subscription-sync';
import type { AuthStatusResponse } from '@/lib/types';
import { useToast } from './toast';
import { useFocusTrap } from './use-focus-trap';

export const AUTH_CHANGED_EVENT = 'libretv:auth-changed';
export const AUTH_STORAGE_EVENT = 'libretv-auth-event';

function notifyAuthChanged(verified: boolean) {
  window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT, { detail: { verified } }));
  try { localStorage.setItem(AUTH_STORAGE_EVENT, `${Date.now()}:${Math.random()}`); } catch { /* Cross-tab notification is optional. */ }
}

/**
 * 认证上下文：
 * - 页面加载时查询 /api/status 判断会话有效性；
 * - 任何 API 返回 401/503 时全局打开登录框（客户端 API 层统一触发，不再散落检查）。
 */

type SetupRequired = boolean;

interface AuthContextValue {
  checked: boolean;
  verified: boolean;
  /** 服务器未设置 PASSWORD，需要管理员配置 */
  setupRequired: SetupRequired;
  /** /api/status 返回的应用版本（构建时从 package.json 注入） */
  version: string | null;
  loginOpen: boolean;
  openLogin: () => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  checked: false,
  verified: false,
  setupRequired: false,
  version: null,
  loginOpen: false,
  openLogin: () => {},
  logout: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [statusError, setStatusError] = useState('');
  const checkRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const checkAccess = useCallback(async () => {
    checkRef.current?.abort();
    const current = new AbortController();
    checkRef.current = current;
    setStatusError('');
    setChecked(false);
    try {
      // Share the status key with Providers, but never trust an old cached access decision.
      const status = await queryClient.fetchQuery({ queryKey: STATUS_QUERY_KEY, queryFn: () => api.status(), staleTime: 0 });
      if (current.signal.aborted) return;
      const valid = status.passwordRequired === true && status.verified === true;
      setVerified(valid);
      setSetupRequired(!status.passwordRequired);
      setVersion(status.version);
      setChecked(true);
      setModalOpen(!valid);
    } catch {
      if (current.signal.aborted) return;
      setVerified(false);
      setChecked(true);
      setStatusError('无法确认访问权限，请重试或进行访问验证。');
    }
  }, [queryClient]);

  useEffect(() => {
    void checkAccess();
    return () => checkRef.current?.abort();
  }, [checkAccess]);

  useEffect(
    () =>
      onUnauthorized((event) => {
        const setup = (event as CustomEvent).detail === 'setup';
        setSetupRequired(setup);
        checkRef.current?.abort();
        setChecked(true);
        setVerified(false);
        notifyAuthChanged(false);
        setModalOpen(true);
      }),
    []
  );

  const openLogin = useCallback(() => setModalOpen(true), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
      checkRef.current?.abort();
      setChecked(true);
      setVerified(false);
      setModalOpen(true);
      queryClient.removeQueries({ queryKey: STATUS_QUERY_KEY });
      notifyAuthChanged(false);
      toast('已退出登录', 'info');
    } catch {
      toast('退出失败，请重试', 'error');
    }
  }, [toast, queryClient]);

  const handleLoginSuccess = useCallback(async () => {
    // The browser may reject a cookie (e.g. insecure production transport). A successful
    // password POST alone must never mount history, downloads, sources, or the application.
    checkRef.current?.abort();
    const current = new AbortController();
    checkRef.current = current;
    let status: AuthStatusResponse;
    try {
      await queryClient.cancelQueries({ queryKey: STATUS_QUERY_KEY });
      status = await queryClient.fetchQuery<AuthStatusResponse>({
        queryKey: STATUS_QUERY_KEY, queryFn: () => api.status(), staleTime: 0,
      });
    } catch (error) {
      if (current.signal.aborted) return;
      setChecked(true);
      setVerified(false);
      setStatusError('无法确认访问权限，请重试或进行访问验证。');
      throw error;
    }
    if (current.signal.aborted) return;
    if (status.passwordRequired !== true || status.verified !== true) {
      setChecked(true);
      setVerified(false);
      setSetupRequired(!status.passwordRequired);
      throw new Error('访问会话未生效，请确认连接后重新验证。');
    }
    setChecked(true);
    setVerified(true);
    setSetupRequired(false);
    setStatusError('');
    setVersion(status.version);
    setModalOpen(false);
    notifyAuthChanged(true);
    // 登录前以 401 失败的查询（如豆瓣推荐）需要重新拉取
    queryClient.invalidateQueries();
    toast('验证成功', 'success');
    try {
      await applyEnvPresets(status);
    } catch {
      // 补拉预置数据失败不影响登录后的正常使用
    }
  }, [toast, queryClient]);

  return (
    <AuthContext.Provider value={{ checked, verified, setupRequired, version, loginOpen: modalOpen, openLogin, logout }}>
      {checked && verified ? children : (
        <AccessGate checked={checked} setupRequired={setupRequired} error={statusError} onLogin={openLogin} onRetry={() => void checkAccess()} />
      )}
      {modalOpen && (
        <LoginModal
          setupRequired={setupRequired}
          onSuccess={handleLoginSuccess}
          onClose={() => setModalOpen(false)}
        />
      )}
    </AuthContext.Provider>
  );
}

function AccessBrand() {
  return <div className="jayflix-brand w-full justify-center mb-6" aria-label="JAYFLIX">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="m15 10 6-3v10l-6-3" />
    </svg>
    <span>JAYFLIX</span>
  </div>;
}

/** Safe entry frame: it contains no application/header/history/source/download hooks. */
function AccessGate({ checked, setupRequired, error, onLogin, onRetry }: {
  checked: boolean; setupRequired: boolean; error: string; onLogin: () => void; onRetry: () => void;
}) {
  return <main className="fixed inset-0 z-[85] flex items-center justify-center bg-surface px-4" aria-label="JAYFLIX 访问入口">
    <div className="w-full max-w-sm text-center">
      <AccessBrand />
      <p className="text-sm text-muted mb-5" role={error ? 'alert' : 'status'}>
        {error || (!checked ? '正在确认访问权限...' : setupRequired ? '请联系部署者配置 PASSWORD 后使用 JAYFLIX。' : '验证访问密码后进入 JAYFLIX。')}
      </p>
      <button className="btn-primary w-full" onClick={onLogin}>{setupRequired ? '查看配置说明' : '访问验证'}</button>
      {error && <button className="btn-ghost w-full mt-3" onClick={onRetry}>重试连接</button>}
    </div>
  </main>;
}

function LoginModal({
  setupRequired,
  onSuccess,
  onClose,
}: {
  setupRequired: boolean;
  onSuccess: () => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const submit = async () => {
    if (!password.trim() || loading) return;
    setLoading(true);
    setError('');
    try {
      await api.login(password);
      await onSuccess();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '验证失败';
      setError(msg === '需要登录' ? '密码错误' : msg);
      setPassword('');
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={setupRequired ? '需要配置密码' : '访问验证'}
      >
        <AccessBrand />
        {setupRequired ? (
          <>
            <h2 className="text-lg font-semibold text-content mb-3">需要配置密码</h2>
            <p className="text-sm text-muted leading-relaxed">
              为确保安全，必须设置 <code className="text-accent">PASSWORD</code> 环境变量才能使用 JAYFLIX。
              请联系管理员在部署配置中添加该变量后重启服务。
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold text-content mb-1">访问验证</h2>
            <p className="text-sm text-muted mb-4">请输入密码继续访问 JAYFLIX</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <input
                ref={inputRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input w-full"
                placeholder="密码"
                aria-label="访问密码"
                autoComplete="current-password"
              />
              {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
              <button type="submit" className="btn-primary w-full mt-4" disabled={loading || !password.trim()}>
                {loading ? '验证中...' : '进入'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
