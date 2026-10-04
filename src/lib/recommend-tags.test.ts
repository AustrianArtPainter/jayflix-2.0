import { describe, expect, it } from 'vitest';
import { DEFAULT_MOVIE_TAGS, loadTags, normalizeTags } from './recommend-tags';

describe('existing homepage tag customization', () => {
  it('keeps unique old tags, keeps 热门 immutable, and rejects corrupt values', () => {
    expect(normalizeTags(['喜剧', ' 喜剧 ', ' ', null, '热门'], [])).toEqual(['热门', '喜剧']);
    expect(loadTags('movie', { getItem: (key) => key === 'userMovieTags' ? '["经典","自定义"]' : null })).toEqual(['热门', '经典', '自定义']);
    expect(loadTags('movie', { getItem: () => '{broken' })).toEqual(DEFAULT_MOVIE_TAGS);
    expect(loadTags('movie', { getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_MOVIE_TAGS);
  });
});
