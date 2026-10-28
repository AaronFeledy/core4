import { Schema } from "effect";

export interface ExecWatchReceipt {
  readonly ok: true;
  readonly seq: number;
  readonly state: "ready" | "running" | "finished" | "cancelled";
  readonly exitCode?: number;
  readonly joined?: true;
}

export class ExecWatchProtocolError extends Schema.TaggedError<ExecWatchProtocolError>()(
  "ExecWatchProtocolError",
  { code: Schema.String, message: Schema.String },
) {}

function invalid(code: string): never {
  throw new ExecWatchProtocolError({ code, message: `Container exec watch protocol failed (${code}).` });
}
const maxLineBytes = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Stop-and-wait receipt validation; retained storage never exceeds one private line. */
export class ExecWatchProtocol {
  private readonly line = new Uint8Array(maxLineBytes);
  private used = 0;
  private nextSequence = 1;
  private pendingSequence: number | undefined;
  private phase: "ready" | "running" | "cancelling" = "ready";
  private ready = false;
  private terminal: ExecWatchReceipt | undefined;
  private closed = false;
  private batchDepth = 0;
  private staged: ExecWatchReceipt | undefined;

  constructor(private readonly onReceipt: (receipt: ExecWatchReceipt) => void) {}

  request(): Uint8Array {
    if (this.closed || this.terminal !== undefined) invalid("request-after-terminal");
    if (this.pendingSequence !== undefined) invalid("request-already-pending");
    if (!Number.isSafeInteger(this.nextSequence)) invalid("sequence-exhausted");
    this.pendingSequence = this.nextSequence++;
    return encoder.encode(`${JSON.stringify({ op: "status", seq: this.pendingSequence })}\n`);
  }

  markLaunched(): void {
    if (
      this.phase !== "ready" ||
      !this.ready ||
      this.pendingSequence !== undefined ||
      this.terminal !== undefined
    )
      invalid("launch-without-ready");
    this.phase = "running";
  }

  beginCancel(): void {
    this.phase = "cancelling";
  }

  beginBatch(): void {
    this.batchDepth++;
  }
  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.staged !== undefined) {
      const receipt = this.staged;
      this.staged = undefined;
      this.onReceipt(receipt);
    }
  }
  abortBatch(): void {
    this.batchDepth = 0;
    this.staged = undefined;
  }
  hasPendingReply(): boolean {
    return this.pendingSequence !== undefined;
  }

  feed(bytes: Uint8Array): void {
    this.beginBatch();
    try {
      for (const byte of bytes) {
        if (this.closed || this.terminal !== undefined) invalid("bytes-after-terminal");
        if (this.pendingSequence === undefined) invalid("unsolicited-reply");
        if (byte > 127) invalid("non-ascii-reply");
        if (byte !== 10) {
          if (this.used === maxLineBytes) invalid("line-limit");
          this.line[this.used++] = byte;
          continue;
        }
        if (this.used === 0) invalid("empty-reply");
        const receipt = this.decodeLine(decoder.decode(this.line.subarray(0, this.used)));
        this.used = 0;
        this.pendingSequence = undefined;
        if (receipt.state === "ready") this.ready = true;
        if (receipt.joined === true) this.terminal = receipt;
        this.staged = receipt;
      }
      this.endBatch();
    } catch (error) {
      this.abortBatch();
      throw error;
    }
  }

  end(): ExecWatchReceipt {
    if (this.used !== 0) invalid("partial-line");
    if (this.pendingSequence !== undefined) invalid("missing-reply");
    if (this.terminal === undefined) invalid("missing-terminal");
    this.closed = true;
    return this.terminal;
  }

  private decodeLine(line: string): ExecWatchReceipt {
    // The private Go encoder emits literal flat fields. Escapes and duplicate keys
    // would let JSON.parse hide a stale sequence behind a later field.
    if (line.includes("\\")) invalid("escaped-token");
    const keys = new Set<string>();
    for (const match of line.matchAll(/"([^"\\]+)"\s*:/gu)) {
      const key = match[1];
      if (key === undefined || keys.has(key)) invalid("duplicate-field");
      keys.add(key);
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid("malformed-json");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("invalid-receipt");
    const fields = Object.keys(value);
    if (fields.some((key) => !["ok", "seq", "state", "exitCode", "joined", "error"].includes(key)))
      invalid("unknown-field");
    if (
      !("seq" in value) ||
      value.seq !== this.pendingSequence ||
      typeof value.seq !== "number" ||
      !Number.isSafeInteger(value.seq) ||
      value.seq <= 0
    )
      invalid("reply-sequence");
    if (!("ok" in value)) invalid("invalid-receipt");
    if (value.ok === false) {
      if (!("error" in value) || typeof value.error !== "string" || !/^[a-z-]{1,64}$/.test(value.error))
        invalid("invalid-helper-failure");
      invalid(`helper-${value.error}`);
    }
    if (value.ok !== true || !("state" in value) || "error" in value) invalid("invalid-receipt");
    if (value.state === "ready" || value.state === "running") {
      if ("exitCode" in value || "joined" in value) invalid("invalid-running-receipt");
      if (this.phase === "ready" && value.state !== "ready") invalid("running-before-launch");
      if (this.phase === "running" && value.state !== "running") invalid("ready-after-launch");
      return { ok: true, seq: value.seq, state: value.state };
    }
    if (this.phase === "ready") invalid("terminal-before-launch");
    if (!("joined" in value) || value.joined !== true) invalid("unjoined-terminal");
    if (value.state === "cancelled") {
      if (this.phase !== "cancelling" || "exitCode" in value) invalid("invalid-cancelled-receipt");
      return { ok: true, seq: value.seq, state: "cancelled", joined: true };
    }
    if (
      value.state !== "finished" ||
      !("exitCode" in value) ||
      typeof value.exitCode !== "number" ||
      !Number.isInteger(value.exitCode) ||
      value.exitCode < 0 ||
      value.exitCode > 255
    )
      invalid("invalid-terminal-status");
    return { ok: true, seq: value.seq, state: "finished", joined: true, exitCode: value.exitCode };
  }
}

/** Strict watch-only framing. The general payload attach decoder remains unchanged. */
export class ExecWatchAttachDecoder {
  private mode: "raw" | "framed" | undefined;
  private readonly header = new Uint8Array(8);
  private headerUsed = 0;
  private remaining = 0;

  constructor(private readonly protocol: ExecWatchProtocol) {}

  feed(bytes: Uint8Array): void {
    this.protocol.beginBatch();
    try {
      this.feedChunk(bytes);
      this.protocol.endBatch();
    } catch (error) {
      this.protocol.abortBatch();
      throw error;
    }
  }

  private feedChunk(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.mode === undefined) {
      if (bytes[0] === 123) this.mode = "raw";
      else if (bytes[0] === 1 || bytes[0] === 2) this.mode = "framed";
      else invalid("invalid-attach-prefix");
    }
    if (this.mode === "raw") {
      this.protocol.feed(bytes);
      return;
    }
    let offset = 0;
    while (offset < bytes.length) {
      if (this.remaining === 0) {
        if (!this.protocol.hasPendingReply()) invalid("unsolicited-attach-bytes");
        const take = Math.min(8 - this.headerUsed, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + take), this.headerUsed);
        this.headerUsed += take;
        offset += take;
        if (this.headerUsed !== 8) continue;
        if (this.header[0] === 2) invalid("watch-stderr");
        if (this.header[0] !== 1 || this.header[1] !== 0 || this.header[2] !== 0 || this.header[3] !== 0)
          invalid("invalid-attach-header");
        this.remaining = new DataView(this.header.buffer).getUint32(4);
        this.headerUsed = 0;
        if (this.remaining === 0 || this.remaining > maxLineBytes + 1) invalid("attach-frame-limit");
      }
      const take = Math.min(this.remaining, bytes.length - offset);
      this.protocol.feed(bytes.subarray(offset, offset + take));
      this.remaining -= take;
      if (this.remaining !== 0 && !this.protocol.hasPendingReply()) invalid("trailing-attach-payload");
      offset += take;
    }
  }

  end(): ExecWatchReceipt {
    if (this.headerUsed !== 0 || this.remaining !== 0) invalid("partial-attach-frame");
    return this.protocol.end();
  }
}
