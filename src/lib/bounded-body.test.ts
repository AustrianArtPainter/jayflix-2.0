import { describe, expect, it, vi } from 'vitest';
import { readBoundedBody, readManifest } from './bounded-body';

describe('bounded document buffering', () => {
  it('decodes a small manifest without trusting Content-Length', async () => {
    const response = new Response('#EXTM3U\n片段.ts', { headers: { 'content-length': '999999999' } });
    expect(await readManifest(response)).toBe('#EXTM3U\n片段.ts');
  });
  it('cancels oversized streamed bodies without collecting all chunks', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel });
    await expect(readBoundedBody(new Response(stream), 4)).rejects.toThrow('超过');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('accepts exactly the limit and handles missing bodies', async () => {
    expect(await readBoundedBody(new Response(new Uint8Array([1, 2, 3, 4])), 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(await readBoundedBody(new Response(null), 4)).toHaveLength(0);
  });
});
