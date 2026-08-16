/**
 * Reference coercion: turn anything the user can plausibly mean by
 * "this image" into a wire ImageReference — with auto-promotion of reused
 * local bytes to persistent assets (inline base64 is an EPHEMERAL asset on
 * the ElevenLabs side and may be deleted after the generation completes).
 */
import { readFile } from 'node:fs/promises';
import { sha256, sniffMime } from '../common/hash.js';
import { errRef } from '../common/errors.js';
import type { ImageReference, Wire } from '../wire/transport.js';
import type { RefStore } from './store.js';
import type { Generation } from '../image/generation.js';

/** Anything that can act as a reference image. */
export type RefInput =
  | string // './hero.png' | 'gen_…' | 'asset:…' | '@name' | 'https://…'
  | Buffer
  | Uint8Array
  | Generation
  | ImageReference; // already wire-shaped → passed through

export interface CoerceContext {
  wire: Wire;
  store: RefStore;
  /** Upload reused local bytes as a persistent asset after N sightings. Default 2; 0/Infinity disables. */
  promoteAfter?: number;
}

const MAX_INLINE = 25 * 1024 * 1024; // API limit: 25MB decoded

export async function resolveRef(input: RefInput, ctx: CoerceContext): Promise<ImageReference> {
  // Generation entity (duck-typed to avoid a hard class dependency)
  if (typeof input === 'object' && input !== null && 'id' in input && typeof (input as Generation).id === 'string' && !('type' in input) && !(input instanceof Uint8Array)) {
    return { type: 'generation', generationId: (input as Generation).id };
  }
  // Already wire-shaped
  if (typeof input === 'object' && input !== null && 'type' in input) {
    return input as ImageReference;
  }
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    return bytesRef(Buffer.from(input), ctx);
  }

  const s = input as string;
  if (s.startsWith('gen_')) return { type: 'generation', generationId: s };
  if (s.startsWith('asset:')) return { type: 'asset', assetId: s.slice('asset:'.length) };
  if (s.startsWith('@')) {
    const name = s.slice(1);
    const assetId = await ctx.store.named(name);
    if (!assetId) throw errRef(s, `no named ref "${name}" — add it with \`11img refs add ${name} <path>\``);
    return { type: 'asset', assetId };
  }
  if (s.startsWith('http://') || s.startsWith('https://')) {
    const res = await fetch(s);
    if (!res.ok) throw errRef(s, `HTTP ${res.status} fetching it`);
    return bytesRef(Buffer.from(await res.arrayBuffer()), ctx);
  }
  // Anything else is a local path
  let bytes: Buffer;
  try {
    bytes = await readFile(s);
  } catch (e) {
    throw errRef(s, e instanceof Error ? e.message : String(e));
  }
  return bytesRef(bytes, ctx);
}

async function bytesRef(bytes: Buffer, ctx: CoerceContext): Promise<ImageReference> {
  if (bytes.byteLength > MAX_INLINE) {
    throw errRef('<bytes>', `image is ${(bytes.byteLength / 1e6).toFixed(1)}MB; the API caps references at 25MB`);
  }
  const hash = sha256(bytes);
  const promoted = await ctx.store.promoted(hash);
  if (promoted) return { type: 'asset', assetId: promoted };

  const threshold = ctx.promoteAfter ?? 2;
  const seen = await ctx.store.markSeen(hash);
  if (threshold > 0 && seen >= threshold) {
    const mime = sniffMime(bytes);
    const asset = await ctx.wire.createAsset(bytes, `11img:${hash.slice(0, 12)}`, mime);
    await ctx.store.setPromoted(hash, asset.assetId);
    return { type: 'asset', assetId: asset.assetId };
  }
  return {
    type: 'inline_base64',
    contentBase64: bytes.toString('base64'),
    mimeType: sniffMime(bytes),
  };
}
