/**
 * Provider-owned log follower engine.
 *
 * A provider that declares `serviceLogSources: true` realizes each declared
 * `strategy: "follow"` source at `lando logs` time by following the declared
 * in-container file. This module is the provider-neutral engine that owns the
 * shared follow semantics — finite-vs-follow, missing-file readiness,
 * rotation (rename+create and copytruncate), incremental UTF-8 line framing,
 * per-source `maxLineBytes` bounding, `since`/`tail`, ordering, and
 * scope-reaping — so every provider (and the SDK fake provider) shares one
 * tested implementation instead of a `tail -F` shell-out.
 *
 * File access is a low-level scoped seam ({@link LogFileAccess}); the real
 * container adapter is provider-specific, while the engine and the in-memory
 * seam ({@link makeMemoryLogFileAccess}) are live and deterministically
 * testable under Effect's `TestClock`.
 *
 * The engine emits {@link LogFollowEvent}s: `line` events carry a source-tagged
 * {@link LogChunk}, and `diagnostic` events carry the follower's own per-source
 * notices (pending / unavailable / since-unsupported / rotated / truncated).
 * A provider's `logs()` projects only `line` events into its `LogChunk` stream;
 * diagnostics are surfaced elsewhere (`lando info`), never as service log lines.
 */
import { Chunk, Clock, Duration, Effect, Option, Stream } from "effect";

import { ProviderUnavailableError } from "../errors/index.ts";
import type { LogSource, LogSourceId, ServiceName } from "../schema/index.ts";
import type { LogChunk, ProviderError } from "../services/index.ts";

/** Default per-source line bound: over-long/binary lines truncate here. */
export const DEFAULT_MAX_LINE_BYTES = 65_536;
/** Default follow poll cadence (Clock-driven, so `TestClock` controls it). */
export const DEFAULT_POLL_INTERVAL_MILLIS = 250;
/** Default bounded readiness wait for a not-yet-created follow file. */
export const DEFAULT_READINESS_TIMEOUT_MILLIS = 30_000;
/** Default per-read byte ceiling; reads loop until EOF so this only bounds memory. */
export const DEFAULT_MAX_READ_BYTES = 65_536;

/** Device/inode/size identity used to detect rotation and truncation. */
export interface LogFileStat {
  readonly dev: string;
  readonly ino: string;
  readonly size: bigint;
}

/** One bounded read from a file handle. */
export interface LogFileRead {
  readonly bytes: Uint8Array;
  readonly nextOffset: bigint;
  readonly eof: boolean;
}

/** A handle to a single open inode; `close` reaps it (see `Stream.ensuring`). */
export interface LogFileHandle<E = ProviderError> {
  readonly stat: Effect.Effect<LogFileStat, E>;
  readonly read: (offset: bigint, maxBytes: number) => Effect.Effect<LogFileRead, E>;
  readonly close: Effect.Effect<void>;
}

/**
 * Low-level file-access seam. `stat` resolves `Option.none()` for a missing
 * path (never an error), so missing-file handling stays in the engine. The
 * engine closes every handle it opens (rotation reopens explicitly; the live
 * handle closes via `Stream.ensuring` on normal end, Ctrl+C, or a dropped
 * stream), so `open` needs no `Scope` and the follower streams stay `R = never`.
 */
export interface LogFileAccess<E = ProviderError> {
  readonly stat: (path: string) => Effect.Effect<Option.Option<LogFileStat>, E>;
  readonly open: (path: string) => Effect.Effect<LogFileHandle<E>, E>;
}

/** Follower-internal per-source notices — never emitted as service `LogChunk`s. */
export type LogFollowDiagnosticKind =
  | "pending"
  | "unavailable"
  | "since-unsupported"
  | "rotated"
  | "truncated";

export interface LogFollowDiagnostic {
  readonly service: ServiceName;
  readonly source: LogSourceId;
  readonly kind: LogFollowDiagnosticKind;
  readonly message: string;
}

/** Engine output: a source-tagged log line, or a follower diagnostic. */
export type LogFollowEvent =
  | { readonly _tag: "line"; readonly chunk: LogChunk }
  | { readonly _tag: "diagnostic"; readonly diagnostic: LogFollowDiagnostic };

export interface FollowLogSourceInput {
  readonly service: ServiceName;
  readonly source: LogSource;
  readonly follow: boolean;
  readonly tail?: number;
  /** Epoch seconds; honored only for `timestamps: true` sources. */
  readonly since?: number;
  readonly access: LogFileAccess;
  readonly maxLineBytes?: number;
  readonly pollIntervalMillis?: number;
  readonly readinessTimeoutMillis?: number;
  readonly maxReadBytes?: number;
}

export interface FollowLogSourcesInput {
  readonly service: ServiceName;
  readonly sources: ReadonlyArray<LogSource>;
  readonly follow: boolean;
  readonly tail?: number;
  readonly since?: number;
  readonly access: LogFileAccess;
  /** Optional single-source id filter (`--source`). */
  readonly source?: LogSourceId;
  readonly maxLineBytes?: number;
  readonly pollIntervalMillis?: number;
  readonly readinessTimeoutMillis?: number;
  readonly maxReadBytes?: number;
}

/** A complete framed line plus whether it was truncated by `maxLineBytes`. */
export interface FramedLine {
  readonly text: string;
  readonly truncated: boolean;
}

const LF = 0x0a;
const CR = 0x0d;
const TRUNCATED_MARKER = " …[truncated]";

/**
 * Byte-level incremental line framer. Buffering complete lines by byte (split
 * only on `\n`, which never appears mid-UTF-8-codepoint) means a multi-byte
 * codepoint can never be split across reads; decode happens per complete line.
 * `maxLineBytes` bounds the buffer: overflow bytes are dropped and the line is
 * marked truncated, so a huge/binary line cannot exhaust memory.
 */
export const makeLineFramer = (maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) => {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let line: number[] = [];
  let overflowed = false;

  const emit = (): FramedLine => {
    let end = line.length;
    if (end > 0 && line[end - 1] === CR) end -= 1;
    const text = decoder.decode(Uint8Array.from(line.slice(0, end)));
    const framed: FramedLine = {
      text: overflowed ? `${text}${TRUNCATED_MARKER}` : text,
      truncated: overflowed,
    };
    line = [];
    overflowed = false;
    return framed;
  };

  const feed = (bytes: Uint8Array): ReadonlyArray<FramedLine> => {
    const out: FramedLine[] = [];
    for (const byte of bytes) {
      if (byte === LF) {
        out.push(emit());
        continue;
      }
      if (line.length < maxLineBytes) {
        line.push(byte);
      } else {
        overflowed = true;
      }
    }
    return out;
  };

  /** Flush a trailing partial line (finite EOF / end of a rotated inode). */
  const flush = (): ReadonlyArray<FramedLine> => {
    if (line.length === 0 && !overflowed) return [];
    return [emit()];
  };

  return { feed, flush };
};

type LineFramer = ReturnType<typeof makeLineFramer>;

const ISO_LEADING = /^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/u;

const parseFramed = (
  service: ServiceName,
  source: LogSource,
  framed: FramedLine,
): { readonly chunk: LogChunk; readonly epochSeconds?: number } => {
  if (source.timestamps !== true) {
    return { chunk: { service, source: source.id, stream: source.stream, line: framed.text } };
  }
  const match = ISO_LEADING.exec(framed.text);
  if (match === null) {
    return { chunk: { service, source: source.id, stream: source.stream, line: framed.text } };
  }
  const timestamp = new Date(match[1] ?? "");
  if (Number.isNaN(timestamp.getTime())) {
    return { chunk: { service, source: source.id, stream: source.stream, line: framed.text } };
  }
  return {
    chunk: { service, source: source.id, stream: source.stream, line: match[2] ?? "", timestamp },
    epochSeconds: Math.floor(timestamp.getTime() / 1000),
  };
};

const diagnostic = (
  service: ServiceName,
  source: LogSource,
  kind: LogFollowDiagnosticKind,
  message: string,
): LogFollowEvent => ({ _tag: "diagnostic", diagnostic: { service, source: source.id, kind, message } });

const missingRequiredLogSource = (source: LogSource, path: string): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId: "log-follow",
    operation: "logs",
    message: `Required log source "${String(source.id)}" file ${path} is not present.`,
    remediation:
      "Create the declared log file, remove required: true, or redirect the log source to console.",
  });

interface FollowerState {
  handle: LogFileHandle;
  dev: string;
  ino: string;
  offset: bigint;
}

const appendLines = (
  target: FramedLine[],
  lines: ReadonlyArray<FramedLine>,
  tail: number | undefined,
): void => {
  target.push(...lines);
  if (tail === undefined) return;
  if (tail <= 0) {
    target.length = 0;
    return;
  }
  if (target.length > tail) target.splice(0, target.length - tail);
};

// Reads a handle from `state.offset` to EOF in bounded steps, feeding the
// framer. Advances `state.offset`. Returns the complete lines produced. When a
// tail window is supplied, only that many complete lines are retained while
// reading so large historical logs do not allocate one object per old line.
const readToEnd = (
  state: FollowerState,
  framer: LineFramer,
  maxReadBytes: number,
  tail?: number,
): Effect.Effect<ReadonlyArray<FramedLine>, ProviderError> =>
  Effect.gen(function* () {
    const lines: FramedLine[] = [];
    let done = false;
    while (!done) {
      const read = yield* state.handle.read(state.offset, maxReadBytes);
      state.offset = read.nextOffset;
      if (read.bytes.length > 0) appendLines(lines, framer.feed(read.bytes), tail);
      done = read.eof;
    }
    return lines;
  });

const applyTail = (lines: ReadonlyArray<FramedLine>, tail: number | undefined): ReadonlyArray<FramedLine> =>
  tail === undefined || lines.length <= tail ? lines : lines.slice(lines.length - tail);

// Bounded readiness wait: poll `stat` until the file appears or the deadline
// passes. Clock-driven (TestClock-compatible) and gate-clean — no
// Effect.retry/repeat/schedule/Schedule.
const waitForFile = (
  access: LogFileAccess,
  path: string,
  deadlineMillis: number,
  pollIntervalMillis: number,
): Effect.Effect<Option.Option<LogFileStat>, ProviderError> =>
  Effect.gen(function* () {
    let current = yield* access.stat(path);
    while (Option.isNone(current)) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= deadlineMillis) return Option.none();
      yield* Effect.sleep(Duration.millis(pollIntervalMillis));
      current = yield* access.stat(path);
    }
    return current;
  });

/**
 * Follow (or snapshot) a single declared `follow` source, emitting source-tagged
 * line events and follower diagnostics (pending, unavailable, rotated, truncated).
 */
export const followLogSource = (
  input: FollowLogSourceInput,
): Stream.Stream<LogFollowEvent, ProviderError> => {
  const { service, source, follow } = input;
  const maxLineBytes = input.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const pollIntervalMillis = input.pollIntervalMillis ?? DEFAULT_POLL_INTERVAL_MILLIS;
  const readinessTimeoutMillis = input.readinessTimeoutMillis ?? DEFAULT_READINESS_TIMEOUT_MILLIS;
  const maxReadBytes = input.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  const path = String(source.path);

  const sinceActive = input.since !== undefined && source.timestamps === true;
  const sinceEpoch = sinceActive ? input.since : undefined;

  const lineEvents = (lines: ReadonlyArray<FramedLine>): ReadonlyArray<LogFollowEvent> => {
    const out: LogFollowEvent[] = [];
    for (const framed of lines) {
      const parsed = parseFramed(service, source, framed);
      if (sinceEpoch !== undefined && parsed.epochSeconds !== undefined && parsed.epochSeconds < sinceEpoch) {
        continue;
      }
      out.push({ _tag: "line", chunk: parsed.chunk });
    }
    return out;
  };

  // Handle lifetime is engine-owned: rotation reopens close the prior handle
  // explicitly, and the live handle closes via `Stream.ensuring` on normal end,
  // interrupt (Ctrl+C), or a dropped stream — so `open` needs no `Scope` and the
  // follower stream stays `R = never`.
  type BodyState =
    | { readonly kind: "open"; readonly stat: LogFileStat }
    | { readonly kind: "poll"; readonly state: FollowerState };

  const buildBody = (initialStat: LogFileStat): Stream.Stream<LogFollowEvent, ProviderError> => {
    const framer = makeLineFramer(maxLineBytes);
    const live: { handle?: LogFileHandle } = {};

    const step = (
      current: BodyState,
    ): Effect.Effect<readonly [Chunk.Chunk<LogFollowEvent>, Option.Option<BodyState>], ProviderError> =>
      Effect.gen(function* () {
        if (current.kind === "open") {
          const handle = yield* input.access.open(path);
          live.handle = handle;
          const state: FollowerState = { handle, dev: current.stat.dev, ino: current.stat.ino, offset: 0n };
          const backfill = yield* readToEnd(state, framer, maxReadBytes, input.tail);
          if (!follow) {
            const tailed = applyTail([...backfill, ...framer.flush()], input.tail);
            return [Chunk.fromIterable(lineEvents(tailed)), Option.none<BodyState>()] as const;
          }
          const backfillEvents = lineEvents(applyTail([...backfill, ...framer.flush()], input.tail));
          return [
            Chunk.fromIterable(backfillEvents),
            Option.some<BodyState>({ kind: "poll", state }),
          ] as const;
        }

        const state = current.state;
        yield* Effect.sleep(Duration.millis(pollIntervalMillis));
        const stat = yield* input.access.stat(path);
        if (Option.isNone(stat)) {
          return [Chunk.empty<LogFollowEvent>(), Option.some<BodyState>(current)] as const;
        }
        const next = stat.value;
        const events: LogFollowEvent[] = [];

        if (next.dev !== state.dev || next.ino !== state.ino) {
          events.push(...lineEvents(yield* readToEnd(state, framer, maxReadBytes)));
          events.push(...lineEvents(framer.flush()));
          events.push(
            diagnostic(service, source, "rotated", `Log source "${String(source.id)}" rotated (${path}).`),
          );
          yield* state.handle.close;
          const reopened = yield* input.access.open(path);
          live.handle = reopened;
          state.handle = reopened;
          state.dev = next.dev;
          state.ino = next.ino;
          state.offset = 0n;
          events.push(...lineEvents(yield* readToEnd(state, framer, maxReadBytes)));
        } else if (next.size < state.offset) {
          events.push(...lineEvents(framer.flush()));
          events.push(
            diagnostic(
              service,
              source,
              "truncated",
              `Log source "${String(source.id)}" was truncated (${path}).`,
            ),
          );
          state.offset = 0n;
          events.push(...lineEvents(yield* readToEnd(state, framer, maxReadBytes)));
        } else if (next.size > state.offset) {
          events.push(...lineEvents(yield* readToEnd(state, framer, maxReadBytes)));
        }

        return [Chunk.fromIterable(events), Option.some<BodyState>(current)] as const;
      });

    return Stream.paginateChunkEffect<BodyState, LogFollowEvent, ProviderError, never>(
      { kind: "open", stat: initialStat },
      step,
    ).pipe(
      Stream.ensuring(Effect.suspend(() => (live.handle === undefined ? Effect.void : live.handle.close))),
    );
  };

  return Stream.unwrap(
    Effect.gen(function* () {
      const prelude: LogFollowEvent[] = [];

      if (input.since !== undefined && source.timestamps !== true) {
        prelude.push(
          diagnostic(
            service,
            source,
            "since-unsupported",
            `--since is unsupported for source "${String(source.id)}" (no timestamps); streaming all lines.`,
          ),
        );
      }

      let resolved = yield* input.access.stat(path);

      if (Option.isNone(resolved)) {
        if (!follow) {
          if (source.required === true) return Stream.fail(missingRequiredLogSource(source, path));
          prelude.push(
            diagnostic(
              service,
              source,
              "unavailable",
              `Log source "${String(source.id)}" file ${path} is not present.`,
            ),
          );
          return Stream.fromIterable(prelude);
        }
        prelude.push(
          diagnostic(
            service,
            source,
            "pending",
            `Waiting for log source "${String(source.id)}" file ${path}.`,
          ),
        );
        const deadline = (yield* Clock.currentTimeMillis) + readinessTimeoutMillis;
        resolved = yield* waitForFile(input.access, path, deadline, pollIntervalMillis);
        if (Option.isNone(resolved)) {
          if (source.required === true) return Stream.fail(missingRequiredLogSource(source, path));
          prelude.push(
            diagnostic(
              service,
              source,
              "unavailable",
              `Log source "${String(source.id)}" file ${path} did not appear within the readiness window.`,
            ),
          );
          return Stream.fromIterable(prelude);
        }
      }

      return Stream.concat(Stream.fromIterable(prelude), buildBody(resolved.value));
    }),
  );
};

/**
 * Follow every `strategy: "follow"` source declared on a service (optionally
 * restricted to one `source` id), merged in arrival order. `redirect`/other
 * strategies are ignored here — they ride the console stream. Non-follow-source
 * ids and unknown ids yield no follower (callers surface those as unavailable).
 */
export const followLogSources = (
  input: FollowLogSourcesInput,
): Stream.Stream<LogFollowEvent, ProviderError> => {
  const selected = input.sources.filter((source) => {
    if (source.strategy !== "follow") return false;
    if (input.source !== undefined && source.id !== input.source) return false;
    return true;
  });

  if (selected.length === 0) return Stream.empty;

  const streams = selected.map((source) =>
    followLogSource({
      service: input.service,
      source,
      follow: input.follow,
      access: input.access,
      ...(input.tail === undefined ? {} : { tail: input.tail }),
      ...(input.since === undefined ? {} : { since: input.since }),
      ...(input.maxLineBytes === undefined ? {} : { maxLineBytes: input.maxLineBytes }),
      ...(input.pollIntervalMillis === undefined ? {} : { pollIntervalMillis: input.pollIntervalMillis }),
      ...(input.readinessTimeoutMillis === undefined
        ? {}
        : { readinessTimeoutMillis: input.readinessTimeoutMillis }),
      ...(input.maxReadBytes === undefined ? {} : { maxReadBytes: input.maxReadBytes }),
    }),
  );

  return Stream.mergeAll(streams, { concurrency: "unbounded" });
};

/** Project a follow event stream down to a provider's `LogChunk` stream. */
export const logFollowLineChunks = <E, R>(
  events: Stream.Stream<LogFollowEvent, E, R>,
): Stream.Stream<LogChunk, E, R> =>
  events.pipe(
    Stream.filterMap((event) => (event._tag === "line" ? Option.some(event.chunk) : Option.none())),
  );

export { makeMemoryLogFileAccess } from "./memory.ts";
export type { MemoryLogFileAccess } from "./memory.ts";
