/**
 * The live byte channel shapes.
 *
 * A raw channel redacts values only and hands bytes straight through; a held
 * channel chunks at a newline or the piece cap, releases complete lines through
 * the time-bounded line hold, and hands a cut piece or the final tail to the
 * hold's `releaseFragment`, which owns suppression, prefix redaction, and the
 * fail-closed start of the next suppression.
 */
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { type LineStreamRedactor, createLineStreamRedactor } from "./line-hold.ts";
import type { DeliveredChunk, LiveBytesChannel, LiveChannelOptions } from "./live-channel.ts";

export const EMPTY = new Uint8Array(0);
export const DEFAULT_MAX_PIECE_BYTES = 65_536;

const concatBytes = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.byteLength === 0) return right;
  if (right.byteLength === 0) return left;
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left);
  out.set(right, left.byteLength);
  return out;
};

const earliest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right);

const createRawBytesChannel = (options: LiveChannelOptions): Omit<LiveBytesChannel, "queue" | "shift"> => {
  const payload = createPayloadRedactor(options.payloadValues);
  return {
    kind: "bytes",
    feed: (bytes) => payload.write(bytes),
    end: () => payload.flush(),
    expire: () => {},
    deadline: () => undefined,
    retainedBytes: () => payload.retainedBytes(),
  };
};

export const createBytesChannel = (
  options: LiveChannelOptions,
  queue: DeliveredChunk[],
): Omit<LiveBytesChannel, "queue" | "shift"> => {
  if (options.raw === true) return createRawBytesChannel(options);
  const { redactor, payloadValues, timeBound } = options;
  const maxPieceBytes = options.maxPieceBytes ?? DEFAULT_MAX_PIECE_BYTES;
  const payload = createPayloadRedactor(payloadValues);
  const lineHold: LineStreamRedactor = createLineStreamRedactor(
    redactor,
    timeBound === undefined ? {} : { timeBound },
  );
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let pending: Uint8Array = EMPTY;
  // Set by the write that first left the value layer holding a possible prefix,
  // cleared as soon as a later write resolves it.
  let payloadHoldStart: number | undefined;
  // Sticky: once the value layer rewrote bytes this channel's retained capture
  // has lost the original context and must fail closed.
  let valueLayerChanged = false;

  const payloadDeadline = (): number | undefined =>
    payloadHoldStart === undefined || timeBound === undefined
      ? undefined
      : payloadHoldStart + timeBound.maxHeldMillis;
  const refreshPayloadHold = (): void => {
    if (!payload.holdsPending()) {
      payloadHoldStart = undefined;
      return;
    }
    payloadHoldStart ??= timeBound?.now();
  };

  const releaseLines = (lines: readonly string[], changed: boolean): void => {
    for (const line of lines) queue.push({ chunk: `${line}\n`, changed });
  };

  // Read the value layer's sentinel count around a call, so a rewrite it made is
  // visible to retained capture: framing and the pattern layer cannot see it.
  const trackRedactions = <A>(operation: () => A): A => {
    const before = payload.redactions();
    const result = operation();
    if (payload.redactions() !== before) valueLayerChanged = true;
    return result;
  };

  const releaseFragment = (text: string): void => {
    releaseLines(lineHold.flush(), true);
    // The hold owns what a cut piece means: consume a released value's
    // continuation, prefix-redact the rest, and fail closed into a new
    // suppression when the piece itself opens a construct.
    const safe = lineHold.releaseFragment(text);
    if (safe.length > 0) queue.push({ chunk: safe, changed: valueLayerChanged || safe !== text });
  };

  const deliverPiece = (piece: Uint8Array, complete: boolean, heldSince?: number): void => {
    const text = decoder.decode(piece, { stream: true });
    if (!complete) {
      releaseFragment(text);
      return;
    }
    const line = text.endsWith("\n") ? text.slice(0, -1) : text;
    const released = lineHold.push(line, heldSince === undefined ? undefined : { heldSince });
    releaseLines(released, valueLayerChanged || released.length !== 1 || released[0] !== line);
  };

  const feedBytes = (bytes: Uint8Array, heldSince?: number): void => {
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = maxPieceBytes - pending.length;
      const newline = bytes.indexOf(10, offset);
      const end = Math.min(bytes.length, offset + remaining, newline < 0 ? bytes.length : newline + 1);
      pending = concatBytes(pending, bytes.subarray(offset, end));
      offset = end;
      if (pending.length === maxPieceBytes || pending.at(-1) === 10) {
        const piece = pending;
        pending = EMPTY;
        deliverPiece(piece, piece.at(-1) === 10, heldSince);
      }
    }
  };

  const releasePendingLine = (heldSince?: number): void => {
    if (pending.length === 0) return;
    const piece = pending;
    pending = EMPTY;
    const text = decoder.decode(piece, { stream: true });
    releaseLines(lineHold.push(text, heldSince === undefined ? undefined : { heldSince }), true);
  };

  const expire = (): void => {
    const nowMs = timeBound?.now();
    if (nowMs === undefined) return;
    const payloadDue = payloadDeadline();
    if (payloadDue !== undefined && nowMs >= payloadDue) {
      // The committed bytes arrived when the payload hold began; a line hold
      // they open keeps that start so a second full window cannot begin.
      const heldSince = payloadHoldStart;
      const expiry = trackRedactions(() => payload.expire());
      if (expiry.bytes.length > 0) feedBytes(expiry.bytes, heldSince);
      if (expiry.heldNewline) releasePendingLine(heldSince);
      refreshPayloadHold();
    }
    const lineDue = lineHold.deadline();
    if (lineDue !== undefined && nowMs >= lineDue) releaseLines(lineHold.expire(), true);
  };

  return {
    kind: "bytes",
    feed: (bytes) => {
      // A write after the deadline fails the expired hold closed first, so a
      // possible registered-value prefix is never released raw.
      expire();
      // Bytes the value layer held arrived when that hold began; a line hold
      // they open keeps the same start instead of a second full window.
      const heldSince = payloadHoldStart;
      feedBytes(
        trackRedactions(() => payload.write(bytes)),
        heldSince,
      );
      refreshPayloadHold();
      return EMPTY;
    },
    end: () => {
      feedBytes(
        trackRedactions(() => payload.flush()),
        payloadHoldStart,
      );
      const piece = pending;
      pending = EMPTY;
      // Decode even an empty tail so a character split at a piece boundary flushes.
      const text = decoder.decode(piece);
      releaseFragment(text);
      payloadHoldStart = undefined;
      return EMPTY;
    },
    expire,
    deadline: () => earliest(lineHold.deadline(), payloadDeadline()),
    retainedBytes: () => payload.retainedBytes() + pending.length + lineHold.retainedBytes(),
  };
};
