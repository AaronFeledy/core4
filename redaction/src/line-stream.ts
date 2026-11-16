/**
 * The per-stream output pipeline built on the line hold.
 *
 * {@link redactLineSequence} redacts lines that arrive already split, keeping
 * each released line at its input position; {@link redactLineText} redacts text
 * that already holds whole lines; and {@link createOutputLineRedactor}
 * composes the whole per-stream pipeline (value layer, framing, line-stream)
 * for raw process bytes. The value layer runs over the joined stream first, so
 * a registered value split across chunks or lines stays masked before the
 * pattern layer or the hold sees it.
 */
import { type FramedLine, makeLineFramer } from "@lando/sdk/log-follow";
import { type Redactor, type TieredRedactionValues, createPayloadRedactor } from "@lando/sdk/secrets";
import { type LineStreamRedactorOptions, createLineStreamRedactor } from "./line-hold.ts";

export * from "./line-hold.ts";

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
    // A line released while a value was suppressed belongs to the line that
    // carried its closer, not to the lines that were dropped inside it.
    const wasSuppressing = stream.suppressing();
    const released = stream.push(line);
    if (wasSuppressing) {
      while (output.length < index) output.push(undefined);
      if (released.length > 0) place(released, index + 1);
      else {
        output.push(undefined);
        blockStart = index + 1;
      }
      return;
    }
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
  /** The canonical `secrets` pattern redactor and its streaming prefix form. */
  readonly redactor: Pick<Redactor, "redactString" | "redactPrefix">;
  /** The exact values, read before every write so later registrations apply. */
  readonly payloadValues: () => Iterable<string> | TieredRedactionValues;
}

/** Framing bound for callers whose records are already bounded by their producer. */
interface OutputLineRedactorOptions extends LineStreamRedactorOptions {
  /**
   * Bytes one framed line may retain before the framer marks it truncated.
   * A live records channel receives lines its producer already bounded, so it
   * raises this to avoid truncating a legitimate long record a second time.
   */
  readonly maxLineBytes?: number;
}

export interface OutputLineRedactor {
  /** Feed raw bytes; returns the lines that are safe to publish now. */
  readonly write: (bytes: Uint8Array) => readonly string[];
  /** End the stream, releasing everything still held. */
  readonly end: () => readonly string[];
  /** Earliest deadline of either layer, or `undefined` when nothing is held. */
  readonly deadline: () => number | undefined;
  /**
   * Release an expired hold fail-closed. Commits a withheld value-layer prefix
   * as masked; when that prefix held the line's newline, the framer's partial
   * line is released as a line. A producer's own partial line is never released.
   */
  readonly expire: () => readonly string[];
  /** Bytes retained by the value layer and the line hold, for sink accounting. */
  readonly retainedBytes: () => number;
}

/**
 * Redact one raw output stream: the value layer runs over the bytes before
 * framing, so a registered value split across chunks or lines stays masked,
 * then each framed line enters the line-stream. A line the framer truncated
 * releases its held block fail-closed, because its closer may be gone.
 */
export const createOutputLineRedactor = (
  scope: OutputRedactionScope,
  options?: OutputLineRedactorOptions,
): OutputLineRedactor => {
  const payload = createPayloadRedactor(scope.payloadValues);
  const framer = makeLineFramer(options?.maxLineBytes);
  const lines = createLineStreamRedactor(scope.redactor, options);
  const timeBound = options?.timeBound;
  // Set by the write that first left the value layer holding a possible prefix.
  let payloadHoldStart: number | undefined;

  const now = (): number | undefined => timeBound?.now();
  const payloadDeadline = (): number | undefined =>
    payloadHoldStart === undefined || timeBound === undefined
      ? undefined
      : payloadHoldStart + timeBound.maxHeldMillis;
  const refreshPayloadHold = (): void => {
    if (!payload.holdsPending()) {
      payloadHoldStart = undefined;
      return;
    }
    payloadHoldStart ??= now();
  };
  const earliest = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined ? right : right === undefined ? left : Math.min(left, right);
  const release = (framed: readonly FramedLine[], heldSince?: number): string[] =>
    framed.flatMap((line) =>
      lines.push(line.text, {
        truncated: line.truncated,
        ...(heldSince === undefined ? {} : { heldSince }),
      }),
    );
  const deadline = (): number | undefined => earliest(lines.deadline(), payloadDeadline());
  const expire = (): readonly string[] => {
    const nowMs = now();
    if (nowMs === undefined) return [];
    const released: string[] = [];
    const payloadDue = payloadDeadline();
    if (payloadDue !== undefined && nowMs >= payloadDue) {
      // The bytes this expiry commits arrived when the payload hold began, so
      // a line-stream hold they open keeps that start instead of a new window.
      const heldSince = payloadHoldStart;
      const expiry = payload.expire();
      if (expiry.bytes.length > 0) {
        released.push(...release(framer.feed(expiry.bytes), heldSince));
        if (expiry.heldNewline) released.push(...release(framer.flush(), heldSince));
      }
      payloadHoldStart = payload.holdsPending() ? nowMs : undefined;
    }
    const lineDue = lines.deadline();
    if (lineDue !== undefined && nowMs >= lineDue) released.push(...lines.expire());
    return released;
  };
  return {
    write: (bytes) => {
      const deadlineMs = deadline();
      const nowMs = now();
      // A write after the deadline fails the expired hold closed first, so a
      // possible registered-value prefix is never released raw.
      const released =
        deadlineMs !== undefined && nowMs !== undefined && nowMs >= deadlineMs ? [...expire()] : [];
      // A payload prefix resolved by this write arrived when that hold began,
      // so a line hold its bytes open keeps the same start instead of buying a
      // second full window.
      const heldSince = payloadHoldStart;
      released.push(...release(framer.feed(payload.write(bytes)), heldSince));
      refreshPayloadHold();
      return released;
    },
    end: () => {
      const released = [
        ...release(framer.feed(payload.flush())),
        ...release(framer.flush()),
        ...lines.flush(),
      ];
      refreshPayloadHold();
      return released;
    },
    deadline,
    expire,
    retainedBytes: () => payload.retainedBytes() + lines.retainedBytes(),
  };
};
