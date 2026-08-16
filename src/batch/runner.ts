/**
 * Batch runner: N generations, bounded concurrency, content-addressed cache.
 *
 * Cache key = sha256 of the exact wire request (model + prompt + resolved
 * references + params). Re-running a manifest re-pays only what changed.
 * Output BYTES are stored in the cache on completion — signed URLs die
 * after ~1h, cached frames don't. Interrupted runs leave a `.pending.json`
 * journal per item and are resumed (not re-charged) on the next run.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, extFor, sha256 } from '../common/hash.js';
import type { GenerateOptions, ImgClient } from '../image/client.js';

export interface BatchItem extends Omit<GenerateOptions, 'signal' | 'webhook'> {
  /** Stable identity of this piece of work (used in filenames and progress). */
  key: string;
}

export interface BatchProgress {
  done: number;
  total: number;
  key: string;
  cached: boolean;
}

export interface BatchOptions {
  /** Parallel generations. Default 4. */
  concurrency?: number;
  /** Cache directory. Default `<client dir>/cache`. */
  cache?: string;
  signal?: AbortSignal;
  onProgress?: (p: BatchProgress) => void;
}

export interface BatchResult {
  key: string;
  /** Generation id (absent when the item failed before submission). */
  id?: string;
  /** Path to the output bytes in the cache (absent on failure). */
  path?: string;
  cached: boolean;
  error?: Error;
}

export async function runBatch(
  client: ImgClient,
  items: BatchItem[],
  opts: BatchOptions = {},
): Promise<BatchResult[]> {
  const cacheDir = opts.cache ?? join(client.dir, 'cache');
  await mkdir(cacheDir, { recursive: true });
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: BatchResult[] = new Array(items.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      opts.signal?.throwIfAborted();
      const item = items[i];
      let result: BatchResult;
      try {
        result = await runOne(client, item, cacheDir, opts.signal);
      } catch (e) {
        result = { key: item.key, cached: false, error: e instanceof Error ? e : new Error(String(e)) };
      }
      results[i] = result;
      done++;
      opts.onProgress?.({ done, total: items.length, key: item.key, cached: result.cached });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

interface CacheMeta {
  id: string;
  mimeType: string;
  file: string;
  key: string;
}

async function runOne(
  client: ImgClient,
  item: BatchItem,
  cacheDir: string,
  signal?: AbortSignal,
): Promise<BatchResult> {
  const { key, ...genOpts } = item;
  const body = await client.buildRequest(genOpts);
  const hash = sha256(canonicalJson(body));
  const metaPath = join(cacheDir, `${hash}.json`);
  const pendingPath = join(cacheDir, `${hash}.pending.json`);

  // Cache hit
  const meta = await readJson<CacheMeta>(metaPath);
  if (meta) return { key, id: meta.id, path: join(cacheDir, meta.file), cached: true };

  // Resume a submission from an interrupted run, else submit fresh
  const pending = await readJson<{ id: string }>(pendingPath);
  const gen = pending
    ? client.result(pending.id)
    : await client.submit(genOpts);
  if (!pending) await writeFile(pendingPath, JSON.stringify({ id: gen.id }));

  await gen.wait({ signal, timeoutMs: item.timeoutMs });
  const bytes = await gen.buffer();
  const mimeType = await gen.mimeType();
  const file = `${hash}.${extFor(mimeType)}`;
  await writeFile(join(cacheDir, file), bytes);
  await writeFile(metaPath, JSON.stringify({ id: gen.id, mimeType, file, key } satisfies CacheMeta, null, 2));
  await rm(pendingPath, { force: true });
  return { key, id: gen.id, path: join(cacheDir, file), cached: false };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}
