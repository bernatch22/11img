/**
 * Generation entity. Wraps a generation id and hides the two footguns of the
 * raw API: the async pending→completed lifecycle (wait with backoff) and the
 * ~1h expiry of signed contentUrls (url() re-fetches when stale; save() and
 * buffer() always download through a fresh URL).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errGenerationFailed, errPollTimeout, ImgError, type FailureReason } from '../common/errors.js';
import type { GenerationState, Wire } from '../wire/transport.js';

export interface WaitOptions {
  signal?: AbortSignal;
  /** Give up polling after this long. Default 300_000 (5 min). */
  timeoutMs?: number;
  /** Called on every poll with the current state. */
  onPoll?: (state: GenerationState) => void;
}

const URL_STALE_MS = 50 * 60 * 1000; // refresh signed URLs older than 50 min

export class Generation {
  private state: GenerationState | undefined;
  private stateAt = 0;

  constructor(
    readonly id: string,
    private readonly wire: Wire,
  ) {}

  /** Wrap an existing generation id (e.g. persisted in a DB). */
  static from(id: string, wire: Wire): Generation {
    return new Generation(id, wire);
  }

  get status(): GenerationState['status'] | 'unknown' {
    return this.state?.status ?? 'unknown';
  }

  /** Poll until the generation is terminal. Resolves this same entity. */
  async wait(opts: WaitOptions = {}): Promise<this> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const started = Date.now();
    let delay = 1000;
    for (;;) {
      opts.signal?.throwIfAborted();
      const state = await this.refresh();
      opts.onPoll?.(state);
      if (state.status === 'completed') return this;
      if (state.status === 'failed') {
        throw errGenerationFailed(this.id, state.failureReason as FailureReason, state.errorMessage);
      }
      if (Date.now() - started > timeoutMs) throw errPollTimeout(this.id, timeoutMs);
      await sleep(delay, opts.signal);
      delay = Math.min(delay * 1.5, 5000);
    }
  }

  /** A FRESH signed download URL (they expire ~1h after issue). */
  async url(): Promise<string> {
    const state = await this.completed();
    return state.contentUrl;
  }

  async mimeType(): Promise<string> {
    return (await this.completed()).contentMimeType;
  }

  /** Download the output bytes. */
  async buffer(): Promise<Buffer> {
    const url = await this.url();
    const res = await fetch(url);
    if (!res.ok) {
      throw new ImgError('11img/download', `Downloading ${this.id} failed (HTTP ${res.status})`, true);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /** Download to a file (parent dirs created). Returns the path. */
  async save(path: string): Promise<string> {
    const bytes = await this.buffer();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return path;
  }

  private async completed(): Promise<{ contentUrl: string; contentMimeType: string }> {
    const fresh = this.state?.status === 'completed' && Date.now() - this.stateAt < URL_STALE_MS;
    const state = fresh ? this.state! : await this.refresh();
    if (state.status === 'failed') {
      throw errGenerationFailed(this.id, state.failureReason as FailureReason, state.errorMessage);
    }
    if (state.status !== 'completed') {
      throw new ImgError(
        '11img/not-finished',
        `Generation ${this.id} is still ${state.status}; call wait() first`,
        true,
      );
    }
    return state;
  }

  private async refresh(): Promise<GenerationState> {
    this.state = await this.wire.getImage(this.id);
    this.stateAt = Date.now();
    return this.state;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
