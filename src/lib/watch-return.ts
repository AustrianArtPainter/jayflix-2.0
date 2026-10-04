/** Return only a path for Next's router; never pass an untrusted URL to it. */
export function safeWatchReturnUrl(value: string | null, origin: string): string | null {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    // Legacy links sometimes encode this value twice; URLSearchParams has
    // already removed the first layer before calling this function.
    const decoded = /^(https?:|\/)/i.test(value) ? value : decodeURIComponent(value);
    if (/[\u0000-\u0020\u007f]/.test(decoded) || !/^(https?:\/\/|\/)/i.test(decoded)) return null;
    if (/[\u0000-\u001f\u007f]/.test(decodeURIComponent(decoded))) return null;
    const base = new URL(origin);
    const target = new URL(decoded, base.origin);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin || target.username || target.password) return null;
    // A path beginning with // would be interpreted as a host by router.push.
    if (target.pathname.startsWith('//')) return null;
    return target.pathname + target.search + target.hash;
  } catch { return null; }
}
