/**
 * Time-bounded streaming sink for command output.
 *
 * Followed logs and machine stream frames arrive one record at a time, but a
 * credential, registered value, or open quoted construct can span several
 * records. Each provenance channel therefore keeps its framing and redaction
 * state across records ({@link createLiveChannel}) and holds an unresolved
 * construct only until the caller-owned clock reaches its deadline. At the
 * deadline the hold fails closed, so a quiet producer can never stall live
 * output indefinitely.
 *
 * Every state change and delivery runs under one semaphore, and one timer per
 * sink sleeps until the earliest held deadline. `finish` flushes all channels,
 * drains pending output, then interrupts the timer and closes its scope even
 * when a write fails.
 */

import { LIVE_LINE_HOLD_MILLIS } from "@lando/redaction/line-stream";
import { type LiveChannel, createLiveChannel } from "@lando/redaction/live-channel";
import { makeLiveHoldTimer } from "@lando/redaction/live-hold-timer";
import { RedactionService } from "@lando/redaction/service";
import {
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
  identityRedactor,
} from "@lando/sdk/command-result";
import type { CommandResultFormat } from "@lando/sdk/schema";
import { Renderer, StreamFrameSink, type StreamFrameSinkFrame } from "@lando/sdk/services";
import { Clock, Effect, type Fiber, Layer, Option, Scope, Semaphore } from "effect";
import { RendererHost } from "./host.ts";

interface FramedMetadata {
  readonly _tag: "stdout" | "stderr";
  readonly service?: string;
  readonly source?: string;
}

interface Channel {
  readonly frame: FramedMetadata;
  readonly live: LiveChannel;
}

const earliest = (left: number | undefined, right: number | undefined): number | undefined =>
  left === undefined ? right : right === undefined ? left : Math.min(left, right);

/**
 * Build the live stream sink for one command result format. The caller owns
 * `finish`; every path that produces output must run it so held construction
 * is released and the timer scope is closed.
 */
export const makeStreamFrameSink = Effect.fnUntraced(function* (format: CommandResultFormat) {
  const renderer = yield* Renderer;
  const redaction = yield* RedactionService;
  const sourceEnv = (yield* RendererHost)?.env ?? process.env;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv });
  const bodyRedactor = yield* redaction.forProfile("secrets", {
    sourceEnv,
    excludeWholeTokenValues: true,
  });
  const values = yield* redaction.payloadValues({ sourceEnv });
  const encoder = new TextEncoder();
  const channels = new Map<string, Channel>();
  const lock = Semaphore.makeUnsafe(1);
  const timerScope = yield* Scope.make("sequential");
  // Captured lazily so a TestClock provided at run time drives both the hold
  // deadlines and the timer sleep.
  let clock: { readonly currentTimeMillisUnsafe: () => number } | undefined;
  let nowMs = 0;
  let finished = false;

  const refreshNow = Effect.gen(function* () {
    if (clock === undefined) clock = yield* Clock.clockWith(Effect.succeed);
    nowMs = clock.currentTimeMillisUnsafe();
  });
  const timeBound = { maxHeldMillis: LIVE_LINE_HOLD_MILLIS, now: () => nowMs };

  const metadataFor = (frame: StreamFrameSinkFrame): FramedMetadata => ({
    _tag: frame._tag,
    ...(frame.service === undefined ? {} : { service: redactor.redactString(frame.service) }),
    ...(frame.source === undefined ? {} : { source: redactor.redactString(frame.source) }),
  });

  const newChannel = (frame: StreamFrameSinkFrame): Channel => {
    const common = { payloadValues: values, timeBound };
    let live: LiveChannel;
    if (frame.kind === "record") {
      live = createLiveChannel({
        kind: "record",
        redactor,
        ...common,
        // Text output prefixes each delivered chunk, so a record stays one line.
        ...(format === "text" ? { maxPieceBytes: Number.MAX_SAFE_INTEGER } : {}),
      });
    } else if (format === "json") {
      live = createLiveChannel({ kind: "bytes", redactor: bodyRedactor, ...common });
    } else {
      // Interactive text output stays a raw value-only passthrough.
      live = createLiveChannel({ kind: "bytes", redactor: bodyRedactor, raw: true, ...common });
    }
    return { frame: metadataFor(frame), live };
  };

  const encodeFrame = (channel: Channel, chunk: string) => {
    const options = {
      chunk,
      ...(channel.frame.service === undefined ? {} : { service: channel.frame.service }),
      ...(channel.frame.source === undefined ? {} : { source: channel.frame.source }),
      redactor: identityRedactor,
    };
    return channel.frame._tag === "stdout"
      ? encodeStreamStdoutFrame(options)
      : encodeStreamStderrFrame(options);
  };

  const writeText = (channel: Channel, line: string): string =>
    channel.frame.service === undefined
      ? `${line}\n`
      : channel.frame.source === undefined
        ? `${channel.frame.service} ${channel.frame._tag}: ${line}\n`
        : `${channel.frame.service} ${channel.frame._tag} [${channel.frame.source}]: ${line}\n`;

  const writeRaw = (channel: Channel, bytes: Uint8Array) =>
    bytes.length === 0
      ? Effect.void
      : channel.frame._tag === "stderr"
        ? renderer.output.stderr(bytes)
        : renderer.output.stdout(bytes);

  const drain = Effect.fnUntraced(function* (channel: Channel) {
    while (channel.live.queue.length > 0) {
      const delivered = channel.live.queue[0];
      if (delivered === undefined) return;
      if (format === "json") {
        yield* renderer.output.stdout(`${yield* encodeFrame(channel, delivered.chunk)}\n`);
      } else {
        // Record chunks carry their own terminator; the text prefix supplies it.
        const line = delivered.chunk.endsWith("\n") ? delivered.chunk.slice(0, -1) : delivered.chunk;
        const output = channel.frame._tag === "stderr" ? renderer.output.stderr : renderer.output.stdout;
        yield* output(writeText(channel, line));
      }
      channel.live.shift();
    }
  });

  /** End one channel (kind change or finish): release holds, write, drain. */
  const endChannel = Effect.fnUntraced(function* (channel: Channel) {
    yield* writeRaw(channel, channel.live.end());
    yield* drain(channel);
  });

  const earliestDeadline = (): number | undefined => {
    let deadline: number | undefined;
    for (const channel of channels.values()) deadline = earliest(deadline, channel.live.deadline());
    return deadline;
  };

  const expireDue = Effect.gen(function* () {
    for (const channel of channels.values()) {
      const deadline = channel.live.deadline();
      if (deadline !== undefined && nowMs >= deadline) channel.live.expire();
      yield* drain(channel);
    }
  });

  const delay = makeLiveHoldTimer({
    lock,
    scope: timerScope,
    refreshNow,
    now: () => nowMs,
    deadline: earliestDeadline,
    expire: expireDue,
    isFinished: () => finished,
  });
  const parentScope = yield* Effect.serviceOption(Scope.Scope);
  if (Option.isSome(parentScope)) {
    yield* Effect.addFinalizer(() => delay.close()).pipe(
      Effect.provideService(Scope.Scope, parentScope.value),
    );
  }

  /** Runs one locked state change, then interrupts a superseded timer outside the lock. */
  const serialized = <A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const state: { stale: Fiber.Fiber<void> | undefined } = { stale: undefined };
    const effect = lock.withPermits(1)(
      Effect.gen(function* () {
        const value = yield* body;
        state.stale = yield* delay.schedule();
        return value;
      }),
    );
    return effect.pipe(Effect.ensuring(Effect.suspend(() => delay.interrupt(state.stale))));
  };

  const handleFrame = Effect.fnUntraced(function* (frame: StreamFrameSinkFrame) {
    if (format === "yaml") return;
    const key = JSON.stringify([frame._tag, frame.service, frame.source]);
    const existing = channels.get(key);
    if (existing !== undefined && existing.live.kind !== frame.kind) {
      yield* endChannel(existing);
      channels.delete(key);
    }
    let channel = channels.get(key);
    if (channel === undefined) {
      channel = newChannel(frame);
      channels.set(key, channel);
    }
    if (frame.kind === "record") {
      if (channel.live.kind !== "record") return;
      channel.live.feed(frame.chunk);
      yield* drain(channel);
      return;
    }
    if (channel.live.kind !== "bytes") return;
    const bytes = typeof frame.chunk === "string" ? encoder.encode(frame.chunk) : frame.chunk;
    yield* writeRaw(channel, channel.live.feed(bytes));
    yield* drain(channel);
  });

  const emit = Effect.fnUntraced(function* (frame: StreamFrameSinkFrame): Effect.fn.Return<void> {
    yield* serialized(
      Effect.gen(function* () {
        yield* refreshNow;
        if (finished) return yield* Effect.die(new Error("Command output is already finished."));
        yield* handleFrame(frame);
      }),
    );
  });

  const finish = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
    let stale: Fiber.Fiber<void> | undefined;
    yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          finished = true;
          stale = yield* delay.schedule();
          yield* refreshNow;
          for (const [key, channel] of channels) {
            yield* endChannel(channel);
            if (channel.live.queue.length === 0) channels.delete(key);
          }
        }),
      )
      .pipe(
        Effect.ensuring(Effect.suspend(() => delay.interrupt(stale))),
        Effect.ensuring(Effect.suspend(() => delay.close())),
      );
  });

  return { sink: StreamFrameSink.of({ emit }), finish };
});

export const layerStreamFrameSink = (format: CommandResultFormat) =>
  Layer.effect(
    StreamFrameSink,
    Effect.gen(function* () {
      const owner = yield* makeStreamFrameSink(format);
      yield* Effect.addFinalizer(owner.finish);
      return owner.sink;
    }),
  );
