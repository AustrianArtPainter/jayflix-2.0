export const DEFAULT_MOVIE_TAGS = ['热门', '最新', '经典', '豆瓣高分', '冷门佳片', '华语', '欧美', '韩国', '日本', '动作', '喜剧', '爱情', '科幻', '悬疑', '恐怖', '治愈', '动画'];
export const DEFAULT_TV_TAGS = ['热门', '美剧', '英剧', '韩剧', '日剧', '国产剧', '港剧', '日本动画', '综艺', '纪录片'];

export function normalizeTags(value: unknown, defaults: string[]): string[] {
  if (!Array.isArray(value)) return [...defaults];
  const names = value.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim()).filter((tag) => tag.length > 0 && tag.length <= 32);
  return ['热门', ...new Set(names.filter((name) => name !== '热门'))].slice(0, 64);
}

export function loadTags(type: 'movie' | 'tv', storage: Pick<Storage, 'getItem'>): string[] {
  const defaults = type === 'movie' ? DEFAULT_MOVIE_TAGS : DEFAULT_TV_TAGS;
  try {
    const raw = storage.getItem(type === 'movie' ? 'userMovieTags' : 'userTvTags');
    return raw ? normalizeTags(JSON.parse(raw), defaults) : [...defaults];
  } catch { return [...defaults]; }
}
