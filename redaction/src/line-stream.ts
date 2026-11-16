/**
 * Bounded line-stream redaction.
 *
 * Process output arrives as framed lines, but several canonical secret shapes
 * span newlines: quoted assignment and signed-query values, and the whitespace
 * between `Bearer` and its token. Redacting each line independently therefore
 * leaks such a value one line at a time.
 *
 * This primitive holds a block only while the canonical patterns over the
 * already-redacted block report an open construct. It then redacts the whole
 * block once, so a construct that completes within the hold is masked as one
 * value and collapses to the lines the redactor produced. An unresolved
 * construct is never held without bound: at the line or byte bound, after a
 * line the framer truncated (it may have dropped the closer), or at end of
 * stream, the held region fails closed to `[redacted]` and later lines flow
 * normally. Nothing after the bound is blanked, and a quoted value longer than
 * the bound can therefore expose its continuation beyond the masked region.
 *
 * The caller owns ordering: push lines from one stream in order, and flush
 * that stream at its end. A held stdout block can be overtaken by stderr lines
 * because the two streams hold independently. {@link createOutputLineRedactor}
 * composes the whole per-stream pipeline (value layer, framing, line-stream)
 * for raw process bytes, and {@link redactLineSequence} redacts lines that
 * arrive already split, keeping each released line at its input position.
 */
import { type FramedLine, makeLineFramer } from "@lando/sdk/log-follow";
import {
  type OpenSecretConstruct,
  maskOpenSecretConstruct,
  type Redactor,
  type TieredRedactionValues,
  createPayloadRedactor,
  findOpenSecretConstruct,
} from "@lando/sdk/secrets";

export const DEFAULT_LINE_STREAM_MAX_HELD_LINES = 64;
/** UTF-8 bytes, including separators between held lines. */
export const DEFAULT_LINE_STREAM_MAX_HELD_BYTES = 16 * 1024;

export interface LineStreamPushOptions {
  /** True when the framer dropped bytes from this line, including any closer. */
  readonly truncated?: boolean;
}

export interface LineStreamRedactor {
  /** Feed one framed line; returns the lines that are safe to publish now. */
  readonly push: (line: string, options?: LineStreamPushOptions) => readonly string[];
  /** End the stream, releasing any held block fail-closed. */
  readonly flush: () => readonly string[];
}

export interface LineStreamRedactorOptions {
  readonly maxHeldLines?: number;
  readonly maxHeldBytes?: number;
}

const encoder = new TextEncoder();

/**
 * Create a line-stream redactor. `redactor.redactString` is the canonical
 * `secrets` redactor; with nothing held a push costs one redaction of that line
 * plus the detector. While a quoted value is held, a line without its quote
 * character cannot close it, so the push only counts toward the bounds instead
 * of redacting the whole block again. Skipping can only keep a block held, and
 * every release redacts the whole held block, so the output is unchanged.
 */
export const createLineStreamRedactor = (
  redactor: Pick<Redactor, "redactPrefix">,
  options: LineStreamRedactorOptions = {},
): LineStreamRedactor => {
  const maxHeldLines = options.maxHeldLines ?? DEFAULT_LINE_STREAM_MAX_HELD_LINES;
  const maxHeldBytes = options.maxHeldBytes ?? DEFAULT_LINE_STREAM_MAX_HELD_BYTES;

  let held: string[] = [];
  let heldBytes = 0;
  let heldTruncated = false;
  // Quote character of the leftmost open construct; undefined for `Bearer`.
  let heldQuote: string | undefined;

  const redactedBlock = (): string => redactor.redactPrefix(held.join("\n"));

  const clear = (): void => {
    held = [];
    heldBytes = 0;
    heldTruncated = false;
    heldQuote = undefined;
  };

  const failClosed = (output: string, open: OpenSecretConstruct): readonly string[] => {
    const masked = maskOpenSecretConstruct(output, open);
    clear();
    return masked.split("\n");
  };

  const push: LineStreamRedactor["push"] = (line, pushOptions = {}) => {
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
    return [];
  };

  const flush: LineStreamRedactor["flush"] = () => {
    if (held.length === 0) return [];
    const output = redactedBlock();
    const open = findOpenSecretConstruct(output);
    if (open !== undefined) return failClosed(output, open);
    clear();
    return output.split("\n");
  };

  return { push, flush };
};

/** The value layer over whole text, so a registered value split across lines stays masked. */
const valueSafeText = (scope: OutputRedactionScope, text: string): string => {
  const payload = createPayloadRedactor(scope.payloadValues);
  const decoder = new TextDecoder();
  return (
    decoder.decode(payload.write(new TextEncoder().encode(text)), { stream: true }) +
    decoder.decode(payload.flush())
  );
};

/**
 * Redact lines that arrive already split, as one stream in order. The value
 * layer runs over the joined lines first, then the line-stream. Entry `i` of the
 * result is the safe text published at line `i`'s position, or `undefined` when
 * redaction merged line `i` into the line released before it. A held block that
 * redacts to fewer lines keeps its first positions, so lines after the block
 * keep theirs. A registered value that spans lines merges them before the
 * line-stream runs; positions then follow the merged lines in order.
 */
export const redactLineSequence = (
  scope: OutputRedactionScope,
  lines: readonly string[],
  options?: LineStreamRedactorOptions,
): ReadonlyArray<string | undefined> => {
  if (lines.length === 0) return [];
  const valueSafe = valueSafeText(scope, lines.join("\n")).split("\n");
  const stream = createLineStreamRedactor(scope.redactor, options);
  const output: Array<string | undefined> = [];
  let blockStart = 0;
  const place = (released: readonly string[], blockEnd: number): void => {
    for (let index = blockStart; index < blockEnd; index += 1) output.push(released[index - blockStart]);
    blockStart = blockEnd;
  };
  valueSafe.forEach((line, index) => {
    const released = stream.push(line);
    if (released.length > 0) place(released, index + 1);
  });
  place(stream.flush(), valueSafe.length);
  while (output.length < lines.length) output.push(undefined);
  return output;
};

/**
 * Redact text that already holds whole lines, such as a rendered command
 * result: the value layer runs over the whole text first, then the lines pass
 * the line-stream.
 */
export const redactLineText = (scope: OutputRedactionScope, text: string): string => {
  const lines = createLineStreamRedactor(scope.redactor);
  const safe = valueSafeText(scope, text)
    .split("\n")
    .flatMap((line) => lines.push(line));
  return [...safe, ...lines.flush()].join("\n");
};

/** The two redaction layers one process-output stream needs. */
export interface OutputRedactionScope {
  /** The canonical `secrets` pattern redactor. */
  readonly redactor: Pick<Redactor, "redactString" | "redactPrefix">;
  /** The exact values, read before every write so later registrations apply. */
  readonly payloadValues: () => Iterable<string> | TieredRedactionValues;
}

export interface OutputLineRedactor {
  /** Feed raw bytes; returns the lines that are safe to publish now. */
  readonly write: (bytes: Uint8Array) => readonly string[];
  /** End the stream, releasing everything still held. */
  readonly end: () => readonly string[];
}

/**
 * Redact one raw output stream: the value layer runs over the bytes before
 * framing, so a registered value split across chunks or lines stays masked,
 * then each framed line enters the line-stream. A line the framer truncated
 * releases its held block fail-closed, because its closer may be gone.
 */
export const createOutputLineRedactor = (
  scope: OutputRedactionScope,
  options?: LineStreamRedactorOptions,
): OutputLineRedactor => {
  const payload = createPayloadRedactor(scope.payloadValues);
  const framer = makeLineFramer();
  const lines = createLineStreamRedactor(scope.redactor, options);
  const release = (framed: readonly FramedLine[]): string[] =>
    framed.flatMap((line) => lines.push(line.text, { truncated: line.truncated }));
  return {
    write: (bytes) => release(framer.feed(payload.write(bytes))),
    end: () => [...release(framer.feed(payload.flush())), ...release(framer.flush()), ...lines.flush()],
  };
};
