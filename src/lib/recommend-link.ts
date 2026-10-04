export type RecommendProvider = 'douban' | 'bangumi' | 'baidu';

/** Fixed public destinations retain the legacy cover link without trusting API-supplied HTML/URLs. */
export function recommendLink(id: string, provider: RecommendProvider): string | undefined {
  if (!/^\d+$/.test(id) || provider === 'baidu') return undefined;
  return provider === 'bangumi' ? `https://bgm.tv/subject/${id}` : `https://movie.douban.com/subject/${id}/`;
}
