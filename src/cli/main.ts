#!/usr/bin/env node
/**
 * 11img CLI — a thin client of the SDK: parse → ImgClient → render.
 * stdout carries only machine-consumable output (paths, or JSON with --json);
 * progress and diagnostics go to stderr.
 */
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImgClient } from '../image/client.js';
import { MODELS, type ModelId } from '../models/registry.js';
import { ImgError } from '../common/errors.js';
import { extFor } from '../common/hash.js';
import type { Residency } from '../wire/transport.js';

const HELP = `11img — ElevenLabs image generation

Usage:
  11img "<prompt>" [flags]              generate (default command)
  11img gen -p "<prompt>" [flags]
  11img models [--json]                 model capabilities (the real API enum)
  11img refs add <name> <path|url>      upload a named persistent reference
  11img refs ls | rm <name> | sync
  11img batch <manifest.json> [flags]   N cached generations (see README)
  11img get <gen_id> [-o <dir>]         rescue any generation by id
  11img ls [--status s] [--model m]     list recent generations

Flags:
  -p, --prompt      prompt text            -m, --model    model id (default gpt-image-2)
  -r, --ref         reference (repeatable: path, URL, gen_…, asset:…, @name)
      --mask        mask image (GPT only)  --ar           aspect ratio
      --res         resolution             -q, --quality  low|medium|high (GPT)
      --background  transparent|opaque|auto (gpt-image-1/1.5)
      --seed        integer (Seedream only)
  -o, --out         output dir (default out/)
  -c, --concurrency batch parallelism (default 4)
      --residency   global|us|eu|in|sg     --timeout      wait seconds (default 300)
      --dry-run     validate + print the wire request, spend nothing
      --json        JSON output on stdout

Auth: ELEVENLABS_API_KEY (paid plan with Image & Video permission required).`;

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      prompt: { type: 'string', short: 'p' },
      model: { type: 'string', short: 'm' },
      ref: { type: 'string', short: 'r', multiple: true },
      mask: { type: 'string' },
      ar: { type: 'string' },
      res: { type: 'string' },
      quality: { type: 'string', short: 'q' },
      background: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string', short: 'o' },
      concurrency: { type: 'string', short: 'c' },
      residency: { type: 'string' },
      timeout: { type: 'string' },
      status: { type: 'string' },
      'delete-asset': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (v.help || (positionals.length === 0 && !v.prompt)) {
    console.error(HELP);
    return v.help ? 0 : 1;
  }

  const client = new ImgClient({
    model: v.model as ModelId | undefined,
    residency: v.residency as Residency | undefined,
  });

  const KNOWN = ['gen', 'models', 'refs', 'batch', 'get', 'ls'];
  const command = KNOWN.includes(positionals[0]) ? positionals[0] : 'gen';
  const rest = command === positionals[0] ? positionals.slice(1) : positionals;

  switch (command) {
    case 'models': {
      if (v.json) {
        console.log(JSON.stringify(MODELS, null, 2));
      } else {
        for (const m of MODELS) {
          const bits = [
            m.provider,
            `ar: ${m.aspectRatios.join(',')}`,
            m.resolutions ? `res: ${m.resolutions.join(',')}` : null,
            m.quality ? 'quality' : null,
            m.background ? 'background' : null,
            m.mask ? 'mask' : null,
            m.seed ? 'seed' : null,
            `refs≤${m.maxRefs}`,
            m.unavailableIn ? `NOT in ${m.unavailableIn.join(',')}` : null,
            m.deprecated ? `DEPRECATED, sunset ${m.deprecated.sunset} → use ${m.deprecated.use}` : null,
          ].filter(Boolean);
          console.log(`${m.id}\n  ${bits.join(' · ')}`);
        }
      }
      return 0;
    }

    case 'refs': {
      const [sub, name, source] = rest;
      if (sub === 'add') {
        if (!name || !source) throw new ImgError('11img/usage', 'usage: 11img refs add <name> <path|url>', true);
        const assetId = await client.refs.add(name, source);
        console.error(`@${name} → ${assetId}`);
        console.log(assetId);
      } else if (sub === 'ls') {
        const all = await client.refs.list();
        for (const [n, id] of Object.entries(all)) console.log(`@${n}\t${id}`);
      } else if (sub === 'rm') {
        if (!name) throw new ImgError('11img/usage', 'usage: 11img refs rm <name> [--delete-asset]', true);
        await client.refs.remove(name, { deleteAsset: v['delete-asset'] });
        console.error(`removed @${name}`);
      } else if (sub === 'sync') {
        const all = await client.refs.sync();
        console.error(`synced ${Object.keys(all).length} named refs from workspace assets`);
        for (const [n, id] of Object.entries(all)) console.log(`@${n}\t${id}`);
      } else {
        throw new ImgError('11img/usage', 'usage: 11img refs add|ls|rm|sync', true);
      }
      return 0;
    }

    case 'get': {
      const id = rest[0];
      if (!id) throw new ImgError('11img/usage', 'usage: 11img get <gen_id> [-o dir]', true);
      const gen = client.result(id);
      await gen.wait({ timeoutMs: seconds(v.timeout) });
      const path = join(v.out ?? '.', `${id}.${extFor(await gen.mimeType())}`);
      await gen.save(path);
      console.log(path);
      return 0;
    }

    case 'ls': {
      const res = await client.wire.listImages({
        status: v.status as never,
        modelId: v.model,
      });
      if (v.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        // The list response carries id/status/contentUrl/contentMimeType only —
        // `modelId` is a valid filter but is NOT echoed back per generation.
        for (const g of (res as { generations?: { id: string; status: string; contentMimeType?: string }[] })
          .generations ?? []) {
          console.log(`${g.id}\t${g.status}\t${g.contentMimeType ?? ''}`);
        }
      }
      return 0;
    }

    case 'batch': {
      const manifestPath = rest[0];
      if (!manifestPath) throw new ImgError('11img/usage', 'usage: 11img batch <manifest.json> [-c N]', true);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const items = Array.isArray(manifest) ? manifest : manifest.items;
      const results = await client.batch(items, {
        concurrency: v.concurrency ? Number(v.concurrency) : undefined,
        onProgress: (p) =>
          process.stderr.write(`[${p.done}/${p.total}] ${p.key}${p.cached ? ' (cached)' : ''}\n`),
      });
      const failed = results.filter((r) => r.error);
      if (v.json) {
        console.log(JSON.stringify(results.map((r) => ({ ...r, error: r.error?.message })), null, 2));
      } else {
        for (const r of results) if (r.path) console.log(r.path);
        for (const r of failed) console.error(`FAILED ${r.key}: ${r.error!.message}`);
      }
      return failed.length ? 1 : 0;
    }

    case 'gen': {
      const prompt = v.prompt ?? rest.join(' ');
      if (!prompt) throw new ImgError('11img/usage', 'missing prompt (positional or -p)', true);
      const opts = {
        prompt,
        model: v.model as ModelId | undefined,
        refs: v.ref,
        mask: v.mask,
        aspectRatio: v.ar,
        resolution: v.res,
        quality: v.quality,
        background: v.background,
        seed: v.seed !== undefined ? Number(v.seed) : undefined,
        timeoutMs: seconds(v.timeout),
      };
      if (v['dry-run']) {
        const body = await client.buildRequest(opts);
        console.log(JSON.stringify(truncateInline(body), null, 2));
        return 0;
      }
      process.stderr.write(`generating (${opts.model ?? 'gpt-image-2'})…\n`);
      const gen = await client.generate(opts);
      const path = join(v.out ?? 'out', `${slug(prompt)}-${gen.id.slice(-6)}.${extFor(await gen.mimeType())}`);
      await gen.save(path);
      if (v.json) {
        console.log(JSON.stringify({ id: gen.id, path }));
      } else {
        process.stderr.write(`id: ${gen.id}\n`);
        console.log(path);
      }
      return 0;
    }
  }
  return 1;
}

function seconds(s: string | undefined): number | undefined {
  return s !== undefined ? Number(s) * 1000 : undefined;
}

function slug(text: string): string {
  return (
    text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image'
  );
}

/** Keep --dry-run output readable: elide base64 payloads. */
function truncateInline(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body, (k, val) =>
      k === 'contentBase64' && typeof val === 'string'
        ? `<${val.length} base64 chars>`
        : val,
    ),
  );
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof ImgError && e.showUser) {
      process.stderr.write(`error: ${e.message}\n`);
      if (e.hint) process.stderr.write(`  hint: ${e.hint}\n`);
    } else {
      console.error(e);
    }
    process.exit(1);
  },
);
