import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { checkLiveUrlAllowed, checkUpstreamAllowed, isBlockedByDNS, isPrivateIP, isValidProxyUrl } from './ssrf';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('isPrivateIP', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['192.168.1.1', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['100.127.255.255', true],
    ['100.128.0.1', false],
    ['0.1.2.3', true],
    ['192.0.2.1', true],
    ['198.18.0.1', true],
    ['198.19.255.255', true],
    ['198.51.100.1', true],
    ['203.0.113.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    ['::1', true],
    ['fe80::1', true],
    ['fd00::1', true],
    ['8.8.8.8', false],
    ['1.2.3.4', false],
    // URL.hostname 对 IPv6 会带方括号
    ['[::1]', true],
    ['[fe80::1]', true],
    ['[fd00::1]', true],
    ['[fc00::1]', true],
    // IPv4-mapped IPv6：十六进制形式与点分形式
    ['[::ffff:c0a8:164]', true], // ::ffff:192.168.1.100
    ['::ffff:192.168.1.100', true],
    ['[::ffff:7f00:1]', true], // ::ffff:127.0.0.1
    ['::ffff:127.0.0.1', true],
    ['[::ffff:a9fe:a9fe]', true], // ::ffff:169.254.169.254
    ['[::ffff:a00:1]', true], // ::ffff:10.0.0.1
    ['[::ffff:808:808]', false], // ::ffff:8.8.8.8 公网
    ['::ffff:8.8.8.8', false],
    ['[::ffff:c0a8:164', true], // 单边括号（异常输入）仍要拦
    ['[2606:4700::1111]', false], // 公网 IPv6 不应被误杀
    ['0:0:0:0:0:0:0:1', true],
    ['0:0:0:0:0:ffff:192.168.1.1', true],
    ['0000:0000:0000:0000:0000:ffff:7f00:0001', true],
    ['0:0:0:0:0:ffff:808:808', false],
    ['::192.168.1.1', true],
    ['febf::1', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['3fff::1', true],
    ['2002:7f00:1::', true],
    ['64:ff9b::7f00:1', true],
    ['fe80::1%en0', true],
    ['not-an-ip', true],
  ])('%s → %s', (ip, expected) => {
    expect(isPrivateIP(ip)).toBe(expected);
  });
});

describe('isValidProxyUrl', () => {
  it('放行公网 http(s)', () => {
    expect(isValidProxyUrl('https://cdn.example.com/a.m3u8')).toBe(true);
    expect(isValidProxyUrl('http://1.2.3.4/x.ts')).toBe(true);
  });

  it('拦截内网与保留地址', () => {
    expect(isValidProxyUrl('http://localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://127.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('http://192.168.1.1/x')).toBe(false);
    expect(isValidProxyUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isValidProxyUrl('http://localhost./x')).toBe(false);
    expect(isValidProxyUrl('http://foo.localhost/x')).toBe(false);
    expect(isValidProxyUrl('http://metadata.internal/x')).toBe(false);
    expect(isValidProxyUrl('http://2130706433/x')).toBe(false);
    expect(isValidProxyUrl('http://0x7f000001/x')).toBe(false);
    expect(isValidProxyUrl('http://0177.0.0.1/x')).toBe(false);
    expect(isValidProxyUrl('https://user:pass@cdn.example.com/x')).toBe(false);
  });

  it('拦截带方括号的 IPv6 与 IPv4-mapped 写法', () => {
    expect(isValidProxyUrl('http://[::1]:8080/x')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:192.168.1.100]:8080/list.m3u')).toBe(false);
    expect(isValidProxyUrl('http://[::ffff:127.0.0.1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fe80::1]/x')).toBe(false);
    expect(isValidProxyUrl('http://[fd00::1]/x')).toBe(false);
  });

  it('不误杀公网 IPv6', () => {
    expect(isValidProxyUrl('http://[2606:4700::1111]/x')).toBe(true);
  });

  it('拦截非 http 协议', () => {
    expect(isValidProxyUrl('file:///etc/passwd')).toBe(false);
    expect(isValidProxyUrl('ftp://x.com/a')).toBe(false);
    expect(isValidProxyUrl('not a url')).toBe(false);
  });
});

describe('Node / Workers DNS 防护', () => {
  function mockDNS(v4: string[] = ['93.184.216.34'], v6: string[] = ['2606:4700::1111']) {
    vi.spyOn(dns, 'resolve4').mockResolvedValue(v4 as never);
    vi.spyOn(dns, 'resolve6').mockResolvedValue(v6 as never);
    return vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('Not implemented'));
  }

  it('通过 Workers 支持的 A/AAAA 解析全部公网地址，不调用 lookup', async () => {
    const lookup = mockDNS();
    await expect(checkUpstreamAllowed('https://cdn.example.com/x')).resolves.toEqual({ ok: true });
    expect(dns.resolve4).toHaveBeenCalledWith('cdn.example.com');
    expect(dns.resolve6).toHaveBeenCalledWith('cdn.example.com');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    [['93.184.216.34', '10.0.0.1'], ['2606:4700::1111']],
    [['93.184.216.34'], ['2606:4700::1111', 'fd00::1']],
    [['93.184.216.34'], ['0:0:0:0:0:ffff:a9fe:a9fe']],
    [['127.0.0.1'], []],
    [[], []],
    [['invalid-address'], []],
  ])('拒绝任何一个私网或无效 DNS 结果（含 wildcard 域名）', async (v4, v6) => {
    mockDNS(v4, v6);
    await expect(isBlockedByDNS('https://127.0.0.1.nip.io/x')).resolves.toBe(true);
  });

  it('只存在一种地址族时允许公网，ENODATA 表示无该族记录', async () => {
    mockDNS();
    vi.mocked(dns.resolve6).mockRejectedValue(Object.assign(new Error('no AAAA'), { code: 'ENODATA' }));
    await expect(isBlockedByDNS('https://cdn.example.com/x')).resolves.toBe(false);
  });

  it.each(['ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL', 'ENOTIMP', undefined])('解析错误 %s 时不放行', async (code) => {
    mockDNS();
    vi.mocked(dns.resolve6).mockRejectedValue(Object.assign(new Error('DNS failed'), { code }));
    await expect(isBlockedByDNS('https://cdn.example.com/x')).resolves.toBe(true);
  });

  it('解析同步异常、无结果、无效 URL 均拒绝', async () => {
    mockDNS();
    vi.mocked(dns.resolve4).mockImplementation(() => { throw new Error('Not implemented'); });
    await expect(isBlockedByDNS('https://cdn.example.com/x')).resolves.toBe(true);
    await expect(isBlockedByDNS('bad url')).resolves.toBe(true);
  });

  it('字面量 IP 不发送 DNS 请求', async () => {
    mockDNS();
    await expect(isBlockedByDNS('https://93.184.216.34/x')).resolves.toBe(false);
    await expect(isBlockedByDNS('http://[::ffff:127.0.0.1]/x')).resolves.toBe(true);
    expect(dns.resolve4).not.toHaveBeenCalled();
    expect(dns.resolve6).not.toHaveBeenCalled();
  });

  it('直播私网默认拒绝；显式 Node IPTV 开关仍保留协议校验', async () => {
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '');
    await expect(checkLiveUrlAllowed('http://10.0.0.1/live')).resolves.toMatchObject({ ok: false });
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '1');
    await expect(checkLiveUrlAllowed('http://10.0.0.1/live')).resolves.toEqual({ ok: true });
    await expect(checkLiveUrlAllowed('file:///etc/passwd')).resolves.toMatchObject({ ok: false });
  });
});
