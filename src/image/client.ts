/**
 * ImgClient — the front door. Wraps the official SDK (via Wire) with
 * pre-flight validation, reference coercion, the Generation entity,
 * sessions and batches.
 */
import { validateParams, MODELS, type ModelId, type ModelSpec } from '../models/registry.js';
import { resolveRef, type RefInput } from '../refs/coerce.js';
import { RefStore } from '../refs/store.js';
import { sniffMime } from '../common/hash.js';
import { readFile } from 'node:fs/promises';
import { ElevenWire, type ImageRequest, type Residency, type Wire } from '../wire/transport.js';
import { Generation } from './generation.js';
import { Session, type SessionOptions } from './session.js';
import { runBatch, type BatchItem, type BatchOptions, type BatchResult } from '../batch/runner.js';

export interface ImgClientOptions {
  /** Defaults to ELEVENLABS_API_KEY. */
  apiKey?: string;
  residency?: Residency;
  /** Default model for generate/session/batch. Default: gpt-image-2. */
  model?: ModelId;
  /** State directory (refs.json, cache). Default: .11img in cwd. */
  dir?: string;
  /** Upload reused local reference bytes as persistent assets after N sightings (default 2; 0 disables). */
  promoteRefsAfter?: number;
  /** Injectable transport (tests). */
  wire?: Wire;
}

export interface GenerateOptions {
  prompt: string;
  model?: ModelId;
  /** Reference images: paths, URLs, buffers, 'gen_…', 'asset:…', '@name', Generation. */
  refs?: RefInput[];
  /** Region-masked edit (GPT models). Transparent areas of the mask mark editable regions of refs[0]. */
  mask?: RefInput;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  background?: string;
  seed?: number;
  /** Deliver the terminal result to the workspace's flows webhooks. */
  webhook?: 'all' | string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ImgClient {
  readonly wire: Wire;
  readonly store: RefStore;
  private readonly defaultModel: ModelId;
  private readonly promoteAfter: number;
  readonly dir: string;

  constructor(opts: ImgClientOptions = {}) {
    this.dir = opts.dir ?? '.11img';
    this.wire = opts.wire ?? new ElevenWire({ apiKey: opts.apiKey, residency: opts.residency });
    this.store = new RefStore(this.dir);
    this.defaultModel = opts.model ?? 'gpt-image-2';
    this.promoteAfter = opts.promoteRefsAfter ?? 2;
  }

  /** Runtime model metadata (for pre-flight checks and UI selectors). */
  models(filter?: { deprecated?: boolean }): readonly ModelSpec[] {
    if (filter?.deprecated === false) return MODELS.filter((m) => !m.deprecated);
    return MODELS;
  }

  /**
   * Validate + coerce into the exact wire request, without sending it.
   * This is `--dry-run`, and the seam batch/cache hashing keys off.
   */
  async buildRequest(opts: GenerateOptions): Promise<ImageRequest> {
    const model = opts.model ?? this.defaultModel;
    validateParams({
      model,
      prompt: opts.prompt,
      aspectRatio: opts.aspectRatio,
      resolution: opts.resolution,
      quality: opts.quality,
      background: opts.background,
      seed: opts.seed,
      refCount: opts.refs?.length,
      hasMask: opts.mask !== undefined,
    });
    const ctx = { wire: this.wire, store: this.store, promoteAfter: this.promoteAfter };
    const images = opts.refs?.length
      ? await Promise.all(opts.refs.map((r) => resolveRef(r, ctx)))
      : undefined;
    const mask = opts.mask !== undefined ? await resolveRef(opts.mask, ctx) : undefined;
    const webhook =
      opts.webhook === 'all'
        ? ({ type: 'all' } as const)
        : opts.webhook
          ? ({ type: 'ids', ids: opts.webhook } as const)
          : undefined;
    return {
      modelId: model,
      prompt: opts.prompt,
      images,
      mask,
      aspectRatio: opts.aspectRatio,
      resolution: opts.resolution,
      quality: opts.quality,
      background: opts.background,
      seed: opts.seed,
      webhook,
    } as unknown as ImageRequest;
  }

  /** Queue a generation and return immediately (persist `.id`, poll later). */
  async submit(opts: GenerateOptions): Promise<Generation> {
    const body = await this.buildRequest(opts);
    const { id } = await this.wire.createImage(body);
    return new Generation(id, this.wire);
  }

  /** Queue + wait until completed. The one-liner. */
  async generate(opts: GenerateOptions): Promise<Generation> {
    const gen = await this.submit(opts);
    return gen.wait({ signal: opts.signal, timeoutMs: opts.timeoutMs });
  }

  /** Re-attach to a generation by id (rescue, other process, webhook handler). */
  result(id: string): Generation {
    return Generation.from(id, this.wire);
  }

  /** Masked edit sugar: image + mask + prompt. */
  async edit(opts: GenerateOptions & { image: RefInput; mask: RefInput }): Promise<Generation> {
    const { image, ...rest } = opts;
    return this.generate({ ...rest, refs: [image, ...(opts.refs ?? [])] });
  }

  /** An iterative thread that chains each generation into the next. */
  session(opts: Omit<SessionOptions, 'client'> = {}): Session {
    return new Session({ ...opts, client: this });
  }

  /** N idempotent generations with a content-addressed cache. */
  async batch(items: BatchItem[], opts: BatchOptions = {}): Promise<BatchResult[]> {
    return runBatch(this, items, opts);
  }

  /** Named persistent references (uploaded as ElevenLabs assets). */
  readonly refs = {
    add: async (name: string, source: string | Buffer): Promise<string> => {
      const bytes = Buffer.isBuffer(source)
        ? source
        : source.startsWith('http')
          ? Buffer.from(await (await fetch(source)).arrayBuffer())
          : await readFile(source);
      const asset = await this.wire.createAsset(bytes, `11img:${name}`, sniffMime(bytes));
      await this.store.setNamed(name, asset.assetId);
      return asset.assetId;
    },
    list: async (): Promise<Record<string, string>> => this.store.listNamed(),
    remove: async (name: string, opts: { deleteAsset?: boolean } = {}): Promise<void> => {
      const assetId = await this.store.removeNamed(name);
      if (assetId && opts.deleteAsset) await this.wire.deleteAsset(assetId);
    },
    /** Re-discover named refs uploaded from another machine (assets named `11img:<name>`). */
    sync: async (): Promise<Record<string, string>> => {
      const assets = await this.wire.listAssets('11img:');
      for (const a of assets) {
        if (a.name.startsWith('11img:') && !a.name.match(/^11img:[0-9a-f]{12}$/)) {
          await this.store.setNamed(a.name.slice('11img:'.length), a.assetId);
        }
      }
      return this.store.listNamed();
    },
  };
}
