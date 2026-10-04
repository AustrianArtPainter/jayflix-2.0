import { describe, expect, it } from 'vitest';
import { orbitTestCount } from './orbit-test-config';

describe('production-sized diagnostic presets', () => {
  it.each([['', 212], ['mode=current', 212], ['mode=capacity', 1322], ['count=16', 16], ['count=0', 1], ['count=999999', 1322], ['count=212.9', 212], ['count=NaN', 212], ['count=', 212], ['count=Infinity&mode=capacity', 1322]])('resolves %s to %i actual cards', (query, expected) => {
    expect(orbitTestCount(new URLSearchParams(query))).toBe(expected);
  });
});
