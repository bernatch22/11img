# Changelog

## 0.1.0 — Consistency without a seed

First public release. `11img` sits on top of the official
`@elevenlabs/elevenlabs-js` SDK and adds the layer the generated client cannot:
identity and permanence across a set of images.

The API has no seed on the GPT and Gemini models — only Seedream has one — so
visual consistency has to come from somewhere else. It comes from chaining a
prior generation in as a reference, which makes reference handling the centre of
the library rather than a convenience.

**Reference coercion.** `'./hero.png'`, `'https://…'`, a `Buffer`, `'gen_…'`,
`'asset:…'`, `'@name'` or a previous `Generation` all resolve to the right wire
shape. The API's tagged union (`asset` / `generation` / `inline_base64`) never
has to be written by hand.

**Auto-promotion of reused references.** Inline base64 images are ephemeral on
the ElevenLabs side — the API's own types warn they "may be deleted at any time
after the generation completes". The second time the same bytes are used, 11img
uploads them once as a persistent asset and sends an `asset` reference from then
on. Measured on a 1.1M-character payload: sent once, never again.

**Named references.** `11img refs add hero ./hero.png`, then `@hero` anywhere.
`refs sync` re-discovers them from workspace assets on another machine.

**The `Generation` entity.** Signed download URLs expire, so `save()` and
`buffer()` always fetch a fresh one and `url()` re-issues when stale. Persist the
generation id, never the URL.

**Sessions.** `session()` chains each output into the next turn automatically;
`fork()` branches from any earlier generation in the history.

**Batch with a content-addressed cache.** The cache key is a hash of the exact
wire request, and the cached artefact is the output *bytes* — a dead URL never
costs a frame. Interrupted runs journal their pending generation ids and resume
without re-charging. Measured: 26.5s cold, 1.0s warm at zero credits, and
editing one item of two regenerates exactly one.

**Pre-flight validation.** A runtime model registry, derived from the SDK's
request types, rejects `background` on `gpt-image-2`, `mask` on Gemini, `seed`
outside Seedream and unsupported aspect ratios *before* the request is sent —
because `invalid_parameters` can arrive after credits are charged.

**A CLI**, which did not previously exist anywhere: `gen`, `models`, `refs`,
`batch`, `get`, `ls`, plus `--dry-run` (the exact wire request, zero credits).
stdout carries only paths so it pipes cleanly.

### Notes

- Requires a paid ElevenLabs workspace (Pro or above). Every image endpoint
  answers `402 paid_plan_required` on the free tier, which covers the web UI only.
- The generation list response does not include `model_id`, despite `model_id`
  being a valid filter parameter.
- Signed URLs are issued with a 2-hour expiry, not the ~1 hour documented.
- No unit tests yet. The library was verified end to end against the live API;
  the deliberate I/O seam (`src/wire/`) is there to make them cheap to add.
