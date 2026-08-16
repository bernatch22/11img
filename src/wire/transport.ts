/**
 * The ONLY module that touches @elevenlabs/elevenlabs-js. Everything above
 * depends on the `Wire` interface, which is the single seam mocked in tests.
 */
import { ElevenLabsClient, ElevenLabs } from '@elevenlabs/elevenlabs-js';
import { errHttp, errNoApiKey } from '../common/errors.js';

export type Residency = 'global' | 'us' | 'eu' | 'in' | 'sg';

const BASES: Record<Residency, string> = {
  global: 'https://api.elevenlabs.io',
  us: 'https://api.us.elevenlabs.io',
  eu: 'https://api.eu.residency.elevenlabs.io',
  in: 'https://api.in.residency.elevenlabs.io',
  sg: 'https://api.sg.residency.elevenlabs.io',
};

/** Wire-level request/response shapes are the official SDK's own types. */
export type ImageRequest = ElevenLabs.ImageGenerationRequest;
export type ImageReference = ElevenLabs.ImageReference;
export type GenerationState = ElevenLabs.MediaGenerationResponse;
export type AssetInfo = ElevenLabs.AssetResponse;

export interface WireOptions {
  apiKey?: string;
  residency?: Residency;
}

export interface Wire {
  createImage(body: ImageRequest): Promise<{ id: string }>;
  getImage(id: string): Promise<GenerationState>;
  listImages(req?: ElevenLabs.flows.ImageListRequest): Promise<ElevenLabs.MediaGenerationListResponse>;
  createAsset(data: Buffer, name: string, contentType: string): Promise<AssetInfo>;
  getAsset(assetId: string): Promise<AssetInfo>;
  listAssets(search?: string): Promise<AssetInfo[]>;
  deleteAsset(assetId: string): Promise<void>;
}

export class ElevenWire implements Wire {
  private instance: ElevenLabsClient | undefined;

  constructor(private readonly opts: WireOptions = {}) {}

  /**
   * Built on first use, never in the constructor: ElevenLabsClient throws when
   * no key is present, and offline commands (`models`, `refs ls`, `--dry-run`)
   * must work without credentials.
   */
  private get client(): ElevenLabsClient {
    if (!this.instance) {
      const apiKey = this.opts.apiKey ?? process.env.ELEVENLABS_API_KEY;
      if (!apiKey) throw errNoApiKey();
      this.instance = new ElevenLabsClient({
        apiKey,
        environment: BASES[this.opts.residency ?? 'global'],
      });
    }
    return this.instance;
  }

  async createImage(body: ImageRequest): Promise<{ id: string }> {
    try {
      const res = await this.client.flows.image.create(body);
      return { id: res.id };
    } catch (e) {
      throw errHttp('image create', e);
    }
  }

  async getImage(id: string): Promise<GenerationState> {
    try {
      return await this.client.flows.image.get(id);
    } catch (e) {
      throw errHttp(`image get ${id}`, e);
    }
  }

  async listImages(req?: ElevenLabs.flows.ImageListRequest) {
    try {
      return await this.client.flows.image.list(req ?? {});
    } catch (e) {
      throw errHttp('image list', e);
    }
  }

  async createAsset(data: Buffer, name: string, contentType: string): Promise<AssetInfo> {
    try {
      return await this.client.assets.create({
        asset: { data, filename: name, contentType },
        name,
      });
    } catch (e) {
      throw errHttp(`asset upload "${name}"`, e);
    }
  }

  async getAsset(assetId: string): Promise<AssetInfo> {
    try {
      return await this.client.assets.get(assetId);
    } catch (e) {
      throw errHttp(`asset get ${assetId}`, e);
    }
  }

  async listAssets(search?: string): Promise<AssetInfo[]> {
    try {
      const res = await this.client.assets.list(search ? { search } : {});
      return res.assets ?? [];
    } catch (e) {
      throw errHttp('asset list', e);
    }
  }

  async deleteAsset(assetId: string): Promise<void> {
    try {
      await this.client.assets.delete(assetId);
    } catch (e) {
      throw errHttp(`asset delete ${assetId}`, e);
    }
  }
}
