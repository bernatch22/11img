export { ImgClient, type ImgClientOptions, type GenerateOptions } from './image/client.js';
export { Generation, type WaitOptions } from './image/generation.js';
export { Session, type SessionOptions } from './image/session.js';
export { MODELS, MODEL_IDS, modelSpec, validateParams, type ModelId, type ModelSpec } from './models/registry.js';
export { ImgError, type FailureReason } from './common/errors.js';
export type { RefInput } from './refs/coerce.js';
export type { BatchItem, BatchOptions, BatchResult, BatchProgress } from './batch/runner.js';
export type { Residency, Wire, ImageRequest, ImageReference, GenerationState } from './wire/transport.js';
