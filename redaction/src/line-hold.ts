/**
 * Bounded line-stream redaction.
 *
 * Process output arrives as framed lines, but several canonical secret shapes
 * span newlines: quoted values of an assignment, a colon form, a quoted-key
 * member, or a signed query, and the whitespace between `Bearer` and its token.
 * Redacting each line independently therefore leaks such a value one line at a
 * time.
 *
 * This primitive holds a block only while the canonical patterns over the
 * already-redacted block report an open construct. It then redacts the whole
 * block once, so a construct that completes within the hold is masked as one
 * value and collapses to the lines the redactor produced. An unresolved
 * construct is never held without bound: at the line or byte bound, after a
 * line the framer truncated (it may have dropped the closer), or at end of
 * stream, the held region fails closed to `[redacted]`.
 *
 * The caller owns ordering: push lines from one stream in order, and flush
 * that stream at its end. A held stdout block can be overtaken by stderr lines
 * because the two streams hold independently.
 *
 * A live surface cannot wait for the producer to finish a construct, so it
 * supplies a caller-owned clock (`timeBound`) instead of a timer in this pure
 * primitive: {@link LineStreamRedactor.deadline} reports when the hold began
 * plus the bound, and {@link LineStreamRedactor.expire} releases it fail-closed
 * once that deadline passes.
 */
import {
  type OpenSecretConstruct,
  type Redactor,
  findOpenSecretConstruct,
  maskOpenSecretConstruct,
} from "@lando/sdk/secrets";

const DEFAULT_LINE_STREAM_MAX_HELD_LINES = 64;
/** UTF-8 bytes, including separators between held lines. */
const DEFAULT_LINE_STREAM_MAX_HELD_BYTES = 16 * 1024;
/** How long a live surface may hold an unresolved construct before failing closed. */
export const LIVE_LINE_HOLD_MILLIS = 500;

/** A caller-owned clock; the primitive never schedules its own timer. */
export interface LineStreamTimeBound {
  readonly maxHeldMillis: number;
  /** Caller clock in milliseconds; the caller refreshes it before each touch. */
  readonly now: () => number;
}

interface LineStreamPushOptions {
  /** True when the framer dropped bytes from this line, including any closer. */
  readonly truncated?: boolean;
  /**
   * Start time of the data this line carries, when it was withheld earlier by
   * another layer (a value-layer prefix). A hold opened by this push measures
   * its bound from here instead of from the push, so releasing a prefix that
   * arrived long ago cannot buy a second full window.
   */
  readonly heldSince?: number;
}

export interface LineStreamRedactor {
  /** Feed one framed line; returns the lines that are safe to publish now. */
  readonly push: (line: string, options?: LineStreamPushOptions) => readonly string[];
  /** End the stream, releasing any held block fail-closed. */
  readonly flush: () => readonly string[];
  readonly releaseFragment: (text: string) => string;
  /** Deadline of the current hold, or `undefined` when nothing is held. */
  readonly deadline: () => number | undefined;
  /**
   * Release an expired hold fail-closed. Empty until the caller's clock reaches
   * {@link deadline}; releases from the construct's value to the end of the
   * held region.
   */
  readonly expire: () => readonly string[];
  /** UTF-8 bytes currently retained in the held block. */
  readonly retainedBytes: () => number;
}

export interface LineStreamRedactorOptions {
  readonly maxHeldLines?: number;
  readonly maxHeldBytes?: number;
  readonly timeBound?: LineStreamTimeBound;
}

const encoder = new TextEncoder();

/**
 * Create a line-stream redactor. `redactor.redactPrefix` is the canonical
 * `secrets` redactor without closing an unterminated value, so a construct that
 * arrives in later lines stays visible to the detector; with nothing held a push
 * costs one prefix redaction of that line plus the detector. While a quoted
 * value is held, a line without its quote character cannot close it, so the push
 * only counts toward the bounds instead of redacting the whole block again.
 * Skipping can only keep a block held, and every release redacts the whole held
 * block, so the output is unchanged.
 */
export const createLineStreamRedactor = (
  redactor: Pick<Redactor, "redactPrefix">,
  options: LineStreamRedactorOptions = {},
): LineStreamRedactor => {
  const maxHeldLines = options.maxHeldLines ?? DEFAULT_LINE_STREAM_MAX_HELD_LINES;
  const maxHeldBytes = options.maxHeldBytes ?? DEFAULT_LINE_STREAM_MAX_HELD_BYTES;
  const timeBound = options.timeBound;

  let held: string[] = [];
  let heldBytes = 0;
  let heldTruncated = false;
  // Quote character of the leftmost open construct; undefined for `Bearer`.
  let heldQuote: string | undefined;
  // Set by the push that began the hold; later pushes never reset it.
  let holdStart: number | undefined;
  const redactedBlock = (): string => redactor.redactPrefix(held.join("\n"));

  const clear = (): void => {
    held = [];
    heldBytes = 0;
    heldTruncated = false;
    heldQuote = undefined;
    holdStart = undefined;
  };

  const holdDeadline = (): number | undefined =>
    holdStart === undefined || timeBound === undefined ? undefined : holdStart + timeBound.maxHeldMillis;

  const failClosed = (output: string, open: OpenSecretConstruct): readonly string[] => {
    const masked = maskOpenSecretConstruct(output, open);
    clear();
    return masked.split("\n");
  };

  const pushLine = (line: string, pushOptions: LineStreamPushOptions): readonly string[] => {
    const separator = held.length === 0 ? 0 : 1;
    const bytes = encoder.encode(line).length;
    held.push(line);
    heldBytes += bytes + separator;
    heldTruncated ||= pushOptions.truncated === true;
    const overBound = heldTruncated || held.length > maxHeldLines || heldBytes > maxHeldBytes;
    if (heldQuote !== undefined && !overBound && !line.includes(heldQuote)) return [];

    const output = redactedBlock();
    const open = findOpenSecretConstruct(output);
    if (open === undefined) {
      clear();
      return output.split("\n");
    }
    if (overBound) return failClosed(output, open);
    heldQuote = open.quote;
    holdStart ??= pushOptions.heldSince ?? timeBound?.now();
    return [];
  };

  const expireAt = (nowMs: number): readonly string[] => {
    const deadline = holdDeadline();
    if (deadline === undefined || nowMs < deadline) return [];
    return flush();
  };

  const push: LineStreamRedactor["push"] = (line, pushOptions = {}) => {
    const nowMs = timeBound?.now();
    const expired = nowMs === undefined ? [] : expireAt(nowMs);
    return [...expired, ...pushLine(line, pushOptions)];
  };

  const flush: LineStreamRedactor["flush"] = () => {
    if (held.length === 0) return [];
    const output = redactedBlock();
    const open = findOpenSecretConstruct(output);
    if (open !== undefined) return failClosed(output, open);
    clear();
    return output.split("\n");
  };

  const expire: LineStreamRedactor["expire"] = () => {
    const nowMs = timeBound?.now();
    return nowMs === undefined ? [] : expireAt(nowMs);
  };

  const releaseFragment = (text: string): string => {
    const redacted = redactor.redactPrefix(text);
    const open = findOpenSecretConstruct(redacted);
    if (open === undefined) return redacted;
    return maskOpenSecretConstruct(redacted, open);
  };

  return {
    push,
    flush,
    releaseFragment,
    deadline: holdDeadline,
    expire,
    retainedBytes: () => heldBytes,
  };
};
