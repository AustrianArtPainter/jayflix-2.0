import { safeWatchReturnUrl } from './watch-return';

/** Compatibility only: playback continues in the new upstream /watch implementation. */
export function legacyRedirect(input: URL): URL | null {
  const pathname = input.pathname;
  const target = new URL(input);
  if (pathname.startsWith('/s=')) {
    let title: string;
    try { title = decodeURIComponent(pathname.slice(3)); } catch { return null; }
    target.pathname = '/'; target.search = '';
    target.searchParams.set('s', title);
    return target;
  }
  const routes: Record<string, string> = {
    '/index.html': '/', '/about.html': '/about',
    '/watch.html': '/watch', '/player.html': '/watch',
    '/orbit-test.html': '/orbit-test',
  };
  if (!routes[pathname]) return null;
  target.pathname = routes[pathname];
  if (target.pathname === '/watch') {
    // Old history links put the display name in source and the actual ID in
    // source_code. Keep the old parameters too, so their data is not discarded.
    const code = target.searchParams.get('source_code')?.trim();
    if (code) target.searchParams.set('source', code);
    for (const [oldKey, newKey] of [['customApi', 'sourceUrl'], ['customDetail', 'detail']]) {
      if (!target.searchParams.get(newKey) && target.searchParams.get(oldKey)) {
        target.searchParams.set(newKey, target.searchParams.get(oldKey)!);
      }
    }
  }
  // A compatibility URL must never make a later return action navigate to another origin.
  const rawReturn = target.searchParams.get('returnUrl') ||
    (target.pathname === '/watch' ? target.searchParams.get('back') : null);
  if (rawReturn) {
    const safeReturn = safeWatchReturnUrl(rawReturn, target.origin);
    try {
      if (safeReturn) {
        const back = new URL(safeReturn, target.origin);
        if (back.pathname.startsWith('/s=')) {
          const name = decodeURIComponent(back.pathname.slice(3));
          back.pathname = '/'; back.search = ''; back.searchParams.set('s', name);
        } else if (routes[back.pathname]) back.pathname = routes[back.pathname];
        target.searchParams.set('returnUrl', back.pathname + back.search + back.hash);
      } else target.searchParams.delete('returnUrl');
    } catch { target.searchParams.delete('returnUrl'); }
  }
  return target;
}
