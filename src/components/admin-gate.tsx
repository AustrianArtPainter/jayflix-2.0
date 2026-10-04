'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AUTH_CHANGED_EVENT, AUTH_STORAGE_EVENT, useAuth } from './auth';
import { useFocusTrap } from './use-focus-trap';

type GateState =
  | { phase: 'checking' | 'access' | 'access-setup' | 'admin' | 'admin-setup' | 'error'; error?: string }
  | { phase: 'granted'; expiresAt: number };

const AdminGateContext = createContext<{ onCancel: () => void } | null>(null);

/** The entire child tree stays unmounted until the server validates access AND admin cookies. */
export function AdminGate({ open = true, onCancel, children }: { open?: boolean; onCancel?: () => void; children: ReactNode }) {
  const inherited = useContext(AdminGateContext);
  if (!open) return null;
  if (inherited) return <>{children}</>;
  // Closing unmounts this component, so every subsequent opening starts with a fresh server check.
  return <ActiveAdminGate onCancel={onCancel}>{children}</ActiveAdminGate>;
}

function ActiveAdminGate({ onCancel, children }: { onCancel?: () => void; children: ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: 'checking' });
  const [dismissed, setDismissed] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { openLogin, loginOpen } = useAuth();
  const cancel = useCallback(() => {
    requestRef.current?.abort();
    setDismissed(true);
    onCancel?.();
  }, [onCancel]);

  const check = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ phase: 'checking' });
    setSubmitting(false);
    try {
      const res = await fetch('/api/admin', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (controller.signal.aborted) return;
      if (res.status === 401) { setState({ phase: 'access' }); return; }
      if (res.status === 503) { setState({ phase: 'access-setup' }); return; }
      if (!res.ok) throw new Error('无法验证管理员会话，请重试');
      const body: unknown = await res.json();
      if (controller.signal.aborted) return;
      if (!body || typeof body !== 'object' || !('accessVerified' in body) || body.accessVerified !== true ||
          !('configured' in body) || typeof body.configured !== 'boolean' || !('verified' in body) || typeof body.verified !== 'boolean') {
        throw new Error('管理员会话响应无效，请重试');
      }
      if (!body.configured) { setState({ phase: 'admin-setup' }); return; }
      if (body.verified) {
        if (!('expiresAt' in body) || typeof body.expiresAt !== 'number' || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now()) {
          throw new Error('管理员会话已过期，请重新验证');
        }
        setState({ phase: 'granted', expiresAt: body.expiresAt });
      } else {
        setState({ phase: 'admin' });
      }
    } catch (error) {
      if (!controller.signal.aborted) setState({ phase: 'error', error: error instanceof Error ? error.message : '验证失败，请重试' });
    }
  }, []);

  useEffect(() => {
    if (dismissed) return;
    void check();
    const changed = (event: Event) => {
      requestRef.current?.abort();
      setPassword('');
      setSubmitting(false);
      if ((event as CustomEvent<{ verified?: boolean }>).detail?.verified === false) setState({ phase: 'access' });
      else void check();
    };
    const storage = (event: StorageEvent) => { if (event.key === AUTH_STORAGE_EVENT) void check(); };
    const focus = () => void check();
    window.addEventListener(AUTH_CHANGED_EVENT, changed);
    window.addEventListener('storage', storage);
    window.addEventListener('focus', focus);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener(AUTH_CHANGED_EVENT, changed);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', focus);
    };
  }, [check, dismissed]);

  // Expiry locks the whole drawer; background-tab focus also revalidates rotated/revoked credentials.
  useEffect(() => {
    if (state.phase !== 'granted') return;
    const timer = setTimeout(() => void check(), Math.max(0, Math.min(state.expiresAt - Date.now(), 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [state, check]);

  const promptOpen = !dismissed && !loginOpen && state.phase !== 'granted';
  useFocusTrap(promptOpen, panelRef);
  useEffect(() => {
    if (!promptOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', escape);
    };
  }, [promptOpen, cancel]);

  const submit = async () => {
    if (!password || submitting) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSubmitting(true);
    setState({ phase: 'admin' });
    try {
      const res = await fetch('/api/admin', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      });
      if (controller.signal.aborted) return;
      setPassword('');
      if (res.status === 401) { setState({ phase: 'access' }); return; }
      if (res.status === 503) { await check(); return; }
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        if (!controller.signal.aborted) setState({ phase: 'admin', error: typeof body?.error === 'string' ? body.error : '管理员验证失败，请重试' });
        return;
      }
      // A POST success is insufficient: confirm that the browser actually stored both valid cookies.
      await check();
    } catch {
      if (!controller.signal.aborted) setState({ phase: 'admin', error: '网络请求失败，请重试' });
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  if (dismissed) return null;
  if (state.phase === 'granted') return <AdminGateContext.Provider value={{ onCancel: cancel }}>{children}</AdminGateContext.Provider>;
  if (loginOpen) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80 animate-fade-in"
      onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}>
      <div ref={panelRef} tabIndex={-1} className="bg-surface-raised rounded-xl p-6 w-full max-w-sm mx-4 shadow-2xl outline-none"
        role="dialog" aria-modal="true" aria-label="管理员验证">
        <h2 className="text-lg font-semibold text-content mb-2">管理员验证</h2>
        {state.phase === 'checking' && <p role="status" className="text-sm text-muted">正在验证会话...</p>}
        {state.phase === 'access' && <>
          <p className="text-sm text-muted mb-4">请先完成访问验证，再验证管理员密码以打开设置。</p>
          <button className="btn-primary w-full" onClick={openLogin}>访问验证</button>
        </>}
        {(state.phase === 'access-setup' || state.phase === 'admin-setup') && <p className="text-sm text-muted leading-relaxed">
          请联系部署者配置 <code className="text-accent">{state.phase === 'access-setup' ? 'PASSWORD' : 'ADMINPASSWORD'}</code> 环境变量后重启服务。
        </p>}
        {state.phase === 'admin' && <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <p className="text-sm text-muted mb-4">请输入管理员密码以打开 JAYFLIX 设置</p>
          <input type="password" autoFocus autoComplete="current-password" aria-label="管理员密码" placeholder="管理员密码"
            className="input w-full" value={password} maxLength={4096} onChange={(event) => setPassword(event.target.value)} disabled={submitting} />
          {state.error && <p role="alert" className="mt-2 text-sm text-danger">{state.error}</p>}
          <button type="submit" className="btn-primary w-full mt-4" disabled={submitting || !password}>{submitting ? '验证中...' : '打开设置'}</button>
        </form>}
        {state.phase === 'error' && <>
          <p role="alert" className="text-sm text-danger mb-3">{state.error}</p>
          <button className="btn-primary w-full" onClick={() => void check()}>重试验证</button>
        </>}
        <button type="button" className="btn-ghost w-full mt-3" onClick={cancel}>取消</button>
      </div>
    </div>
  );
}
