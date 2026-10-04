import { readBoundedBody } from './bounded-body';

/** Workers' node:dns flattens CNAMEs into resolve4/6 and reports NODATA as
 * ENOTFOUND. Read typed records from the same Cloudflare resolver instead:
 * Status=0 without this address family is valid; NXDOMAIN/errors fail closed.
 * This fixed resolver is not a user-configurable proxy or an SSRF bypass. */
export async function resolveWorkerAddresses(hostname: string, type: 1 | 28): Promise<string[]> {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', String(type));
  const response = await fetch(url, {
    headers: { Accept: 'application/dns-json' },
    redirect: 'manual', // Workers does not implement redirect:'error'; reject 3xx below.
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('DNS resolver request failed');
  }
  const data = JSON.parse(new TextDecoder().decode(await readBoundedBody(response, 64 * 1024))) as {
    Status?: number; TC?: boolean; Answer?: Array<{ type?: number; data?: unknown }>;
  };
  if (!data || data.Status !== 0 || data.TC === true ||
      (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 128))) {
    throw new Error('DNS resolver returned an unsuccessful or invalid answer');
  }
  const addresses: string[] = [];
  for (const record of data.Answer ?? []) {
    if (!record || (record.type !== 5 && record.type !== type)) throw new Error('Unexpected DNS record type');
    if (record.type === type) {
      if (typeof record.data !== 'string') throw new Error('Invalid DNS address record');
      addresses.push(record.data);
    }
  }
  return addresses;
}
