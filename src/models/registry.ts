/**
 * Runtime model metadata, hand-derived from @elevenlabs/elevenlabs-js@2.64.0
 * request types (api/types/*Request.d.ts and their enums). Compile-time the
 * official union already enforces this; the registry exists for
 *   1. pre-flight validation — fail BEFORE credits are charged, and
 *   2. runtime introspection — a web UI painting model/ratio selectors.
 *
 * When bumping the SDK dependency, re-diff these specs against the new types.
 */
import { errUnknownModel, errUnsupported, ImgError } from '../common/errors.js';

export type ModelId =
  | 'gpt-image-2'
  | 'gpt-image-1.5'
  | 'gpt-image-1'
  | 'gemini-3-pro-image'
  | 'gemini-3.1-flash-image'
  | 'gemini-3.1-flash-lite-image'
  | 'gemini-2.5-flash-image'
  | 'bytedance-seedream-5-pro'
  | 'bytedance-seedream-5-lite';

export interface ModelSpec {
  readonly id: ModelId;
  readonly provider: 'openai' | 'google' | 'bytedance';
  readonly aspectRatios: readonly string[];
  /** Absent → the model has no resolution parameter. */
  readonly resolutions?: readonly string[];
  /** Absent → no quality parameter (GPT family only). */
  readonly quality?: readonly string[];
  /** Absent → no background parameter (gpt-image-1/1.5 only). */
  readonly background?: readonly string[];
  /** Max reference images accepted. */
  readonly maxRefs: number;
  /** Region-masked edit via `mask` (GPT family only). */
  readonly mask: boolean;
  /** Deterministic-ish seed (Seedream only). */
  readonly seed: boolean;
  readonly unavailableIn?: readonly string[];
  readonly deprecated?: { readonly sunset: string; readonly use: ModelId };
}

const AR_WIDE = ['auto', '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;

export const MODELS: readonly ModelSpec[] = [
  {
    id: 'gpt-image-2',
    provider: 'openai',
    aspectRatios: [...AR_WIDE, '1:2', '2:1', '1:3', '3:1'],
    resolutions: ['1K', '2K', '4K'],
    quality: ['low', 'medium', 'high'],
    maxRefs: 10,
    mask: true,
    seed: false,
  },
  {
    id: 'gpt-image-1.5',
    provider: 'openai',
    aspectRatios: ['1:1', '3:2', '2:3'],
    quality: ['low', 'medium', 'high'],
    background: ['transparent', 'opaque', 'auto'],
    maxRefs: 10,
    mask: true,
    seed: false,
    deprecated: { sunset: '2026-12-01', use: 'gpt-image-2' },
  },
  {
    id: 'gpt-image-1',
    provider: 'openai',
    aspectRatios: ['1:1', '3:2', '2:3'],
    quality: ['low', 'medium', 'high'],
    background: ['transparent', 'opaque', 'auto'],
    maxRefs: 10,
    mask: true,
    seed: false,
    deprecated: { sunset: '2026-10-23', use: 'gpt-image-2' },
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'google',
    aspectRatios: AR_WIDE,
    resolutions: ['1K', '2K', '4K'],
    maxRefs: 10,
    mask: false,
    seed: false,
  },
  {
    id: 'gemini-3.1-flash-image',
    provider: 'google',
    aspectRatios: [...AR_WIDE, '1:4', '4:1', '1:8', '8:1'],
    resolutions: ['512', '1K', '2K', '4K'],
    maxRefs: 10,
    mask: false,
    seed: false,
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    provider: 'google',
    aspectRatios: AR_WIDE,
    resolutions: ['1K'],
    maxRefs: 10,
    mask: false,
    seed: false,
  },
  {
    id: 'gemini-2.5-flash-image',
    provider: 'google',
    aspectRatios: AR_WIDE,
    maxRefs: 10,
    mask: false,
    seed: false,
  },
  {
    id: 'bytedance-seedream-5-pro',
    provider: 'bytedance',
    aspectRatios: ['auto', '1:1', '3:4', '4:3', '9:16', '16:9'],
    resolutions: ['1K', '2K'],
    maxRefs: 10,
    mask: false,
    seed: true,
    unavailableIn: ['US'],
  },
  {
    id: 'bytedance-seedream-5-lite',
    provider: 'bytedance',
    aspectRatios: ['auto', '1:1', '3:4', '4:3', '9:16', '16:9'],
    resolutions: ['2K', '3K'],
    maxRefs: 10,
    mask: false,
    seed: true,
    unavailableIn: ['US'],
  },
];

export const MODEL_IDS = MODELS.map((m) => m.id);

export function modelSpec(id: string): ModelSpec {
  const spec = MODELS.find((m) => m.id === id);
  if (!spec) throw errUnknownModel(id, MODEL_IDS);
  return spec;
}

/** Generation parameters as the user writes them, pre-coercion. */
export interface GenerateParams {
  model?: string;
  prompt: string;
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  background?: string;
  seed?: number;
  refCount?: number;
  hasMask?: boolean;
}

/**
 * Pre-flight validation against the registry. Throws a user-facing ImgError
 * before a single credit is spent. Returns the resolved spec.
 */
export function validateParams(p: GenerateParams): ModelSpec {
  const spec = modelSpec(p.model ?? 'gpt-image-2');
  const check = (name: string, value: string | undefined, allowed?: readonly string[]) => {
    if (value === undefined) return;
    if (!allowed) throw errUnsupported(spec.id, name);
    if (!allowed.includes(value)) throw errUnsupported(spec.id, `${name}=${value}`, allowed);
  };
  check('aspectRatio', p.aspectRatio, spec.aspectRatios);
  check('resolution', p.resolution, spec.resolutions);
  check('quality', p.quality, spec.quality);
  check('background', p.background, spec.background);
  if (p.seed !== undefined && !spec.seed) throw errUnsupported(spec.id, 'seed');
  if (p.hasMask && !spec.mask) throw errUnsupported(spec.id, 'mask');
  if ((p.refCount ?? 0) > spec.maxRefs) {
    throw new ImgError(
      '11img/too-many-refs',
      `${spec.id} accepts at most ${spec.maxRefs} reference images, got ${p.refCount}`,
      true,
    );
  }
  return spec;
}
