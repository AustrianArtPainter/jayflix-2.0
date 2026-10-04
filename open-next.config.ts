import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Dynamic API responses and client-side state do not require paid R2/DO/KV resources.
// No durable ISR/tag revalidation is configured; isolate caches remain best effort.
export default defineCloudflareConfig({
  incrementalCache: 'dummy',
  tagCache: 'dummy',
  queue: 'dummy',
});
