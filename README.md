# 11img

Identity & permanence layer over the ElevenLabs image API (`/v1/flows/image`),
built on top of the official `@elevenlabs/elevenlabs-js` SDK — not instead of it.

The official SDK is a faithful, generated wire layer. What it does not give you,
and what nothing else on npm or GitHub gives you either, is here.

## Why

The image API has three sharp edges that every consumer re-implements by hand:

1. **References are a tagged union you must build yourself** — `{type:"asset"}`,
   `{type:"generation"}`, `{type:"inline_base64"}`.
2. **Inline references are ephemeral.** The API's own type documentation says an
   inline image "is stored as an ephemeral asset with no guaranteed retention:
   it may be deleted at any time after the generation completes."
3. **There is no seed on the GPT and Gemini models** (only Seedream has one), so
   visual consistency across a set of images cannot come from a seed.

11img answers all three: references coerce from anything, reused bytes are
auto-promoted to persistent assets, and consistency comes from chaining a prior
generation in as a reference.

## Features

- **Reference coercion** — `'./hero.png' | 'https://…' | Buffer | 'gen_…' | 'asset:…' | '@name' | Generation`
  all become valid wire references.
- **Auto-promotion** — the second time the same local bytes are used, 11img
  uploads them once as a persistent asset (`11img:<hash>`) and sends
  `{type:"asset"}` from then on. Measured: a 1.1M-character base64 payload
  disappears from every subsequent request.
- **Named refs** — `refs add hero ./hero.png`, then `@hero` anywhere.
  Recoverable on another machine with `refs sync`.
- **The `Generation` entity** — signed `contentUrl`s expire; `url()` re-fetches
  when stale, `save()`/`buffer()` always download fresh. Persist `gen.id`,
  never the URL.
- **Sessions** — each turn chains the previous output in as a reference, which
  is what preserves identity in the absence of a seed. `fork()` branches from
  any point in the history.
- **Batch with a content-addressed cache** — the key is a hash of the exact wire
  request. Output *bytes* are cached, so a dead URL never costs you a frame, and
  interrupted runs journal their pending ids and resume without re-charging.
- **Pre-flight validation** — a runtime model registry rejects `background` on
  gpt-image-2, `mask` on Gemini, `seed` outside Seedream, an unsupported aspect
  ratio… *before* a single credit is spent, with an actionable hint.

## Requirements

- Node ≥ 20.
- `ELEVENLABS_API_KEY` from a **paid workspace (Pro or above)**. The free tier
  covers the web UI only; every image endpoint — including `GET /v1/assets` and
  the generation list — answers `402 paid_plan_required`,
  *"This endpoint requires a Pro plan or above."*

## SDK

```ts
import { ImgClient } from '11img';

const img = new ImgClient({ model: 'gpt-image-2', residency: 'eu' });

// one-liner
const hero = await img.generate({
  prompt: 'goalkeeper diving, cinematic',
  aspectRatio: '16:9',
  resolution: '2K',
});
await hero.save('out/hero.png');

// references of any shape
await img.generate({
  prompt: 'same player, far post header',
  refs: ['@hero', './kit-away.png', hero],
});

// iterative thread — each turn chains the previous output
const s = img.session({ defaults: { aspectRatio: '1:1' } });
const v1 = await s.gen('a minimal geometric owl logo, black on white');
const v2 = await s.gen('the same owl logo, now with a thin circular border');
const v3 = await s.fork(v1).gen('the same owl logo, in a rounded square badge');

// fire-and-forget, for a web backend
const job = await img.submit({ prompt: '…', webhook: 'all' });
await db.save(job.id);                  // later: await img.result(id).wait()

// batch — cached, resumable, bounded concurrency
const frames = await img.batch(
  scenarios.map(sc => ({
    key: sc.name,
    prompt: sc.description,
    refs: ['@hero'],
    aspectRatio: '16:9',
  })),
  { concurrency: 4, onProgress: p => console.error(`${p.done}/${p.total}`) },
);
```

## CLI

```bash
11img "a goalkeeper diving, cinematic"                # → out/…png (path on stdout)
11img gen -p "same, far post" -r @hero -r ./kit.png --ar 16:9 --res 2K -q high
11img models                                          # the real API enum + capabilities
11img refs add hero ./hero.png                        # named persistent reference
11img refs ls | rm <name> | sync
11img batch frames.json -c 4                          # manifest = array of BatchItem
11img get <gen_id> -o .                               # rescue any generation by id
11img ls --status failed
11img gen -p "…" --dry-run                            # exact wire request, 0 credits
```

stdout carries only paths (or JSON with `--json`); progress and errors go to
stderr, so `11img "…" | pbcopy` just works.

## Models

Nine models, from the real API enum — `11img models` prints them with their
capabilities. Highlights:

| model | refs | mask | seed | resolution | notes |
|---|---|---|---|---|---|
| `gpt-image-2` | ≤10 | yes | no | 1K/2K/4K | default; 15 aspect ratios; no `background` |
| `gpt-image-1.5` | ≤10 | yes | no | — | has `background`; **sunset 2026-12-01** |
| `gpt-image-1` | ≤10 | yes | no | — | **sunset 2026-10-23** |
| `gemini-3-pro-image` | ≤10 | no | no | 1K/2K/4K | |
| `gemini-3.1-flash-image` | ≤10 | no | no | 512/1K/2K/4K | widest ratios (up to 8:1) |
| `bytedance-seedream-5-*` | ≤10 | no | **yes** | 1K–3K | not available in the US |

The models shown in the ElevenCreative web UI (Nano Banana, FLUX, Krea, Runway,
Kling, Seedream 4.x) are **not** in the API enum.

## State

Everything lives in `.11img/` per project: `refs.json` (named + auto-promoted
refs) and `cache/` (batch outputs + resume journal). The API key is **only** ever
read from `ELEVENLABS_API_KEY` — never written to disk.

## Verified against the live API

Exercised end to end on 2026-08-16 against a paid workspace:

- generation, download, and the `402` path on a free key;
- an asset reference reproducing the source logo exactly inside a new composition;
- session chaining preserving identity across turns without a seed;
- auto-promotion: inline on first use → asset on the second → same asset on the third;
- batch cache: 26.5s cold → 1.0s warm at zero credits, and editing 1 of 2 items
  regenerating exactly 1.

Two places where the live API differs from its documentation:

- The generation **list** response carries `id`, `status`, `content_url` and
  `content_mime_type` only — **not** `model_id`, even though `model_id` is a
  valid filter parameter.
- Signed URLs are issued with `X-Goog-Expires=7200` (2 hours), not the ~1 hour
  the docs state. 11img refreshes at 50 minutes, which is safe either way.

## Ground truth

Model capabilities in `src/models/registry.ts` are derived by hand from the
request types of `@elevenlabs/elevenlabs-js@2.64.0`. When bumping that
dependency, re-diff the specs against the new `api/types/*Request.d.ts`.

## License

MIT
