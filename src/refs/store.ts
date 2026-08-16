/**
 * Persistent reference bookkeeping under `<dir>/refs.json`:
 *   named    — user-named references ('@hero') → uploaded asset ids
 *   promoted — content hash → asset id (auto-promoted reused local images)
 *   seen     — content hash → times sent inline (promotion trigger)
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface StoreData {
  named: Record<string, string>;
  promoted: Record<string, string>;
  seen: Record<string, number>;
}

const EMPTY: StoreData = { named: {}, promoted: {}, seen: {} };

export class RefStore {
  private data: StoreData | undefined;
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'refs.json');
  }

  private async load(): Promise<StoreData> {
    if (this.data) return this.data;
    try {
      this.data = { ...EMPTY, ...JSON.parse(await readFile(this.file, 'utf8')) };
    } catch {
      this.data = structuredClone(EMPTY);
    }
    return this.data!;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, this.file);
  }

  async named(name: string): Promise<string | undefined> {
    return (await this.load()).named[name];
  }

  async setNamed(name: string, assetId: string): Promise<void> {
    (await this.load()).named[name] = assetId;
    await this.save();
  }

  async removeNamed(name: string): Promise<string | undefined> {
    const data = await this.load();
    const id = data.named[name];
    if (id) {
      delete data.named[name];
      await this.save();
    }
    return id;
  }

  async listNamed(): Promise<Record<string, string>> {
    return { ...(await this.load()).named };
  }

  async promoted(hash: string): Promise<string | undefined> {
    return (await this.load()).promoted[hash];
  }

  async setPromoted(hash: string, assetId: string): Promise<void> {
    (await this.load()).promoted[hash] = assetId;
    await this.save();
  }

  /** Increment the inline-send counter for a content hash; returns the new count. */
  async markSeen(hash: string): Promise<number> {
    const data = await this.load();
    data.seen[hash] = (data.seen[hash] ?? 0) + 1;
    await this.save();
    return data.seen[hash];
  }
}
