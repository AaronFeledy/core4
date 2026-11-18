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
 * stream, the held region fails closed to `[redacted]`. A fail-closed release
 * then enters continuation suppression for that value: lines wholly inside it
 * are dropped (merged into the masked value) until its closer arrives, and the
 * line that holds the closer resumes after the whole value, including the
 * shell-word suffix of the `=`/query forms, so a second secret on it is still
 * masked. A released `Bearer` introducer continues the same way: whitespace
 * lines are skipped, and the first token run on a later line is masked when it
 * is a credential (a prose word ends suppression untouched). Suppression
 * carries only constant-size state and ends at the closer, at end of stream, or
 * at the same line/byte bound counted from the start of suppression, after
 * which output flows again.
 *
 * A producer that cuts a piece without a line terminator (a live byte channel at
 * its piece cap) uses {@link LineStreamRedactor.releaseFragment}: it consumes
 * any active suppression, redacts what survives, and fails closed when that
 * piece still opens a construct, so the following pieces stay suppressed too.
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
  type SecretContinuation,
  continueSecretValue,
  findOpenSecretConstruct,
  maskOpenSecretConstruct,
  startSecretContinuation,
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
  /**
   * Release a producer fragment that is not a complete line. Any active
   * suppression consumes it first; the surviving text is prefix-redacted, and a
   * construct it still opens is masked fail-closed while suppression starts for
   * the following pieces. The result is one safe chunk.
   */
  readonly releaseFragment: (text: string) => string;
  /** True while a released value's continuation is still being suppressed. */
  readonly suppressing: () => boolean;
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
  // Set when a fail-closed release left an unresolved value: the following
  // lines of this stream are inside it and stay suppressed until its closer.
  let suppression: SuppressionState | undefined;

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
    // A truncated frame may have dropped the closer, so the value's state is
    // already lost: keep suppressing until the bound, never trust a quote.
    const continuation = startSecretContinuation(output, open);
    if (continuation !== undefined) {
      suppression = { continuation, lines: 0, bytes: 0, desynchronized: heldTruncated };
    }
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

  const suppressed = (
    line: string,
    pushOptions: LineStreamPushOptions,
    state: SuppressionState,
  ): readonly string[] => {
    state.lines += 1;
    state.bytes += encoder.encode(line).length + 1;
    if (pushOptions.truncated === true) state.desynchronized = true;
    if (!state.desynchronized) {
      const step = continueSecretValue(state.continuation, line, "line");
      state.continuation = step.state;
      if (step.prose) {
        // A released Bearer introducer introduced prose, not a credential.
        suppression = undefined;
        return pushLine(line, pushOptions);
      }
      if (step.closedAt >= 0) {
        suppression = undefined;
        const content = line.endsWith("\r") ? line.slice(0, -1) : line;
        const remainder = `${step.replacement}${content.slice(step.closedAt)}`;
        return remainder.length === 0 ? [] : pushLine(remainder, pushOptions);
      }
    }
    if (state.lines > maxHeldLines || state.bytes > maxHeldBytes) {
      // The bound ends suppression; this line and every later one flow again.
      suppression = undefined;
      return pushLine(line, pushOptions);
    }
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
    if (suppression !== undefined) return [...expired, ...suppressed(line, pushOptions, suppression)];
    return [...expired, ...pushLine(line, pushOptions)];
  };

  const flush: LineStreamRedactor["flush"] = () => {
    // A flush also releases a held block before a fragment, so an existing
    // suppression must survive it; at end of stream nothing follows.
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

  /** Consume a fragment through an active suppression, or return it unchanged. */
  const suppressFragment = (text: string): string => {
    const state = suppression;
    if (state === undefined) return text;
    state.bytes += encoder.encode(text).length;
    if (!state.desynchronized) {
      const step = continueSecretValue(state.continuation, text, "fragment");
      state.continuation = step.state;
      if (step.prose) {
        suppression = undefined;
        return text;
      }
      if (step.closedAt >= 0) {
        suppression = undefined;
        const content = text.endsWith("\r") ? text.slice(0, -1) : text;
        return `${step.replacement}${content.slice(step.closedAt)}`;
      }
    }
    if (state.bytes > maxHeldBytes) {
      suppression = undefined;
      return text;
    }
    return "";
  };

  const releaseFragment = (text: string): string => {
    const survivor = suppressFragment(text);
    if (survivor.length === 0) return "";
    const redacted = redactor.redactPrefix(survivor);
    const open = findOpenSecretConstruct(redacted);
    if (open === undefined) return redacted;
    // The piece cut the value before its closer: fail closed from the value and
    // keep suppressing the following pieces, exactly as a bound release does.
    const continuation = startSecretContinuation(redacted, open);
    if (continuation !== undefined) suppression = { continuation, lines: 0, bytes: 0, desynchronized: false };
    return maskOpenSecretConstruct(redacted, open);
  };

  return {
    push,
    flush,
    releaseFragment,
    suppressing: () => suppression !== undefined,
    deadline: holdDeadline,
    expire,
    retainedBytes: () => heldBytes,
  };
};

/** Constant-size continuation state for a value released before its closer. */
interface SuppressionState {
  continuation: SecretContinuation;
  lines: number;
  bytes: number;
  desynchronized: boolean;
}
