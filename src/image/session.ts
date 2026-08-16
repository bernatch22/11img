/**
 * Session — an iterative thread. GPT/Gemini image models have no seed, so
 * visual identity across turns comes from reference chaining: every gen()
 * sends the session's base refs plus the previous generation as references.
 */
import type { Generation } from './generation.js';
import type { GenerateOptions, ImgClient } from './client.js';
import type { RefInput } from '../refs/coerce.js';
import type { ModelId } from '../models/registry.js';

export interface SessionOptions {
  client: ImgClient;
  model?: ModelId;
  /** Base references included in every turn (e.g. '@hero', a style board). */
  refs?: RefInput[];
  /** Fixed params applied to every turn unless overridden. */
  defaults?: Partial<Omit<GenerateOptions, 'prompt' | 'refs'>>;
}

export class Session {
  readonly history: Generation[] = [];
  private readonly client: ImgClient;
  private readonly baseRefs: RefInput[];
  private readonly defaults: Partial<Omit<GenerateOptions, 'prompt' | 'refs'>>;

  constructor(opts: SessionOptions) {
    this.client = opts.client;
    this.baseRefs = opts.refs ?? [];
    this.defaults = { ...(opts.defaults ?? {}), model: opts.model ?? opts.defaults?.model };
  }

  get last(): Generation | undefined {
    return this.history[this.history.length - 1];
  }

  /** One turn: base refs + previous output chained in as a reference. */
  async gen(prompt: string, overrides: Partial<Omit<GenerateOptions, 'prompt'>> = {}): Promise<Generation> {
    const refs: RefInput[] = [...this.baseRefs, ...(overrides.refs ?? [])];
    if (this.last) refs.push(this.last);
    const generation = await this.client.generate({
      ...this.defaults,
      ...overrides,
      prompt,
      refs: refs.length ? refs : undefined,
    });
    this.history.push(generation);
    return generation;
  }

  /** Branch a new session continuing from any earlier generation. */
  fork(from: Generation): Session {
    const s = new Session({ client: this.client, refs: this.baseRefs, defaults: this.defaults });
    s.history.push(from);
    return s;
  }
}
