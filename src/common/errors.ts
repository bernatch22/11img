/**
 * Structured errors. Every error the SDK surfaces is an ImgError with a
 * stable `code`, a `showUser` flag (CLI prints clean vs. with stack) and,
 * where possible, an actionable `hint`.
 */

/** Terminal failure reasons returned by the ElevenLabs flows API. */
export type FailureReason =
  | 'timeout'
  | 'model_error'
  | 'moderated'
  | 'invalid_parameters'
  | 'dependency_failed'
  | 'charging_failed'
  | 'internal_error';

export class ImgError extends Error {
  constructor(
    /** Stable machine-readable code, e.g. `11img/moderated`. */
    readonly code: string,
    message: string,
    /** True → the CLI prints the message (and hint) without a stack trace. */
    readonly showUser: boolean,
    /** What the user can do about it. */
    readonly hint?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ImgError';
  }
}

const FAILURE_HINTS: Record<FailureReason, string> = {
  timeout: 'The model timed out server-side; retrying usually works.',
  model_error: 'Upstream model error; retry, or try another model.',
  moderated: 'Rephrase the prompt; reference images may also be triggering moderation.',
  invalid_parameters: 'Check aspect ratio / resolution / quality against `11img models`.',
  dependency_failed: 'A referenced asset or generation could not be used; verify the ids.',
  charging_failed: 'Credit charge failed; check the workspace balance.',
  internal_error: 'ElevenLabs internal error; retry later.',
};

export const errGenerationFailed = (id: string, reason: FailureReason, detail?: string) =>
  new ImgError(
    `11img/${reason}`,
    `Generation ${id} failed (${reason})${detail ? `: ${detail}` : ''}`,
    true,
    FAILURE_HINTS[reason],
  );

export const errUnknownModel = (model: string, known: readonly string[]) =>
  new ImgError(
    '11img/unknown-model',
    `Unknown model "${model}"`,
    true,
    `Known models: ${known.join(', ')}`,
  );

export const errUnsupported = (model: string, param: string, allowed?: readonly (string | number)[]) =>
  new ImgError(
    '11img/unsupported-param',
    `${model} does not accept ${param}`,
    true,
    allowed?.length ? `Allowed: ${allowed.join(', ')}` : `Drop ${param} or pick another model (see \`11img models\`).`,
  );

export const errPaidPlan = () =>
  new ImgError(
    '11img/paid-plan-required',
    'The image API requires a paid ElevenLabs plan (Pro or higher) and an API key with Image & Video permission',
    true,
    'The free tier only covers the web UI. Upgrade the workspace or use a key from a paid workspace.',
  );

export const errPollTimeout = (id: string, ms: number) =>
  new ImgError(
    '11img/poll-timeout',
    `Generation ${id} not finished after ${Math.round(ms / 1000)}s`,
    true,
    `It may still complete; rescue it later with \`11img get ${id}\`.`,
  );

export const errRef = (input: string, why: string) =>
  new ImgError('11img/bad-ref', `Cannot resolve reference "${input}": ${why}`, true);

export const errHttp = (what: string, cause: unknown) => {
  const status = statusOf(cause);
  if (status === 402) return errPaidPlan();
  return new ImgError(
    '11img/http',
    `${what} failed${status ? ` (HTTP ${status})` : ''}: ${messageOf(cause)}`,
    status !== undefined && status < 500,
    undefined,
    cause,
  );
};

function statusOf(e: unknown): number | undefined {
  if (e && typeof e === 'object' && 'statusCode' in e && typeof e.statusCode === 'number') {
    return e.statusCode;
  }
  return undefined;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
