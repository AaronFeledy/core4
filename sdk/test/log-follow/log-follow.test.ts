import { describe, expect, test } from "bun:test";
import { Cause, Duration, Effect, Exit, Fiber, Ref, Stream, TestClock, TestContext } from "effect";

import {
  type LogFollowEvent,
  followLogSource,
  followLogSources,
  makeLineFramer,
  makeMemoryLogFileAccess,
} from "@lando/sdk/log-follow";
import { LogSource } from "@lando/sdk/schema";
import type { ProviderError } from "@lando/sdk/services";
import { Schema } from "effect";

const SERVICE = "db" as never;

const source = (
  over: Partial<{
    id: string;
    path: string;
    strategy: string;
    timestamps: boolean;
    required: boolean;
    stream: string;
  }> = {},
) =>
  Schema.decodeUnknownSync(LogSource)({
    id: over.id ?? "slow-query",
    path: over.path ?? "/var/log/mysql/slow.log",
    stream: over.stream ?? "stdout",
    strategy: over.strategy ?? "follow",
    ...(over.timestamps === undefined ? {} : { timestamps: over.timestamps }),
    ...(over.required === undefined ? {} : { required: over.required }),
  });

const lines = (events: ReadonlyArray<LogFollowEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "line" ? [event.chunk.line] : []));

const diagnostics = (events: ReadonlyArray<LogFollowEvent>): ReadonlyArray<string> =>
  events.flatMap((event) => (event._tag === "diagnostic" ? [event.diagnostic.kind] : []));

const expectProviderUnavailable = <A>(exit: Exit.Exit<A, ProviderError>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") expect(failure.value._tag).toBe("ProviderUnavailableError");
  }
};

const runFinite = (
  stream: Stream.Stream<LogFollowEvent, ProviderError, never>,
): Promise<ReadonlyArray<LogFollowEvent>> =>
  Effect.runPromise(
    Stream.runCollect(stream).pipe(
      Effect.map((chunk) => [...chunk]),
      Effect.scoped,
      Effect.provide(TestContext.TestContext),
    ) as Effect.Effect<ReadonlyArray<LogFollowEvent>, ProviderError, never>,
  );

describe("makeLineFramer (§6.14.4 framing + bounds)", () => {
  test("S6 splits multi-byte UTF-8 across reads without corruption", () => {
    const framer = makeLineFramer();
    // "héllo\n" — é is 0xC3 0xA9; split it across two feeds.
    const bytes = new TextEncoder().encode("héllo\n");
    const first = framer.feed(bytes.slice(0, 2));
    const rest = framer.feed(bytes.slice(2));
    expect(first).toHaveLength(0);
    expect(rest.map((line) => line.text)).toEqual(["héllo"]);
  });

  test("S6 handles CRLF and flushes a final partial line at EOF", () => {
    const framer = makeLineFramer();
    const fed = framer.feed(new TextEncoder().encode("one\r\ntwo\r\npartial"));
    expect(fed.map((line) => line.text)).toEqual(["one", "two"]);
    expect(framer.flush().map((line) => line.text)).toEqual(["partial"]);
  });

  test("S6 truncates an over-long line with a marker and bounded buffering", () => {
    const framer = makeLineFramer(4);
    const fed = framer.feed(new TextEncoder().encode("ABCDEFGHIJ\nok\n"));
    expect(fed[0]?.truncated).toBe(true);
    expect(fed[0]?.text.startsWith("ABCD")).toBe(true);
    expect(fed[0]?.text).toContain("truncated");
    expect(fed[1]?.text).toBe("ok");
  });
});

describe("followLogSource finite (§6.14.4)", () => {
  test("S1 snapshots up to tail lines then EOFs", async () => {
    const fs = makeMemoryLogFileAccess();
    fs.writeFile("/var/log/mysql/slow.log", "l1\nl2\nl3\nl4\n");
    const events = await runFinite(
      followLogSource({ service: SERVICE, source: source(), follow: false, tail: 2, access: fs.access }),
    );
    expect(lines(events)).toEqual(["l3", "l4"]);
    expect(fs.openHandleCount()).toBe(0);
  });

  test("S1 applies tail while reading a large finite snapshot", async () => {
    const fs = makeMemoryLogFileAccess();
    const body = Array.from({ length: 10_000 }, (_value, index) => `l${index}`).join("\n");
    fs.writeFile("/var/log/mysql/slow.log", `${body}\npartial`);
    const events = await runFinite(
      followLogSource({ service: SERVICE, source: source(), follow: false, tail: 2, access: fs.access }),
    );

    expect(lines(events)).toEqual(["l9999", "partial"]);
  });

  test("S1 flushes a final partial line at EOF in finite mode", async () => {
    const fs = makeMemoryLogFileAccess();
    fs.writeFile("/var/log/mysql/slow.log", "l1\nno-newline");
    const events = await runFinite(
      followLogSource({ service: SERVICE, source: source(), follow: false, access: fs.access }),
    );
    expect(lines(events)).toEqual(["l1", "no-newline"]);
  });

  test("S1 missing file in finite mode emits unavailable and does not wait", async () => {
    const fs = makeMemoryLogFileAccess();
    const events = await runFinite(
      followLogSource({ service: SERVICE, source: source(), follow: false, access: fs.access }),
    );
    expect(diagnostics(events)).toEqual(["unavailable"]);
    expect(lines(events)).toEqual([]);
  });

  test("S1 missing required file in finite mode fails", async () => {
    const fs = makeMemoryLogFileAccess();

    const exit = await Effect.runPromiseExit(
      Stream.runCollect(
        followLogSource({
          service: SERVICE,
          source: source({ required: true }),
          follow: false,
          access: fs.access,
        }),
      ).pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
    );

    expectProviderUnavailable(exit);
  });
});

describe("followLogSource since (§6.14.4)", () => {
  test("S7 timestamps:false + since emits since-unsupported diagnostic", async () => {
    const fs = makeMemoryLogFileAccess();
    fs.writeFile("/var/log/mysql/slow.log", "raw1\nraw2\n");
    const events = await runFinite(
      followLogSource({ service: SERVICE, source: source(), follow: false, since: 1000, access: fs.access }),
    );
    expect(diagnostics(events)).toContain("since-unsupported");
    expect(lines(events)).toEqual(["raw1", "raw2"]);
  });

  test("S7 timestamps:true filters by leading timestamp", async () => {
    const fs = makeMemoryLogFileAccess();
    fs.writeFile("/var/log/mysql/slow.log", "2020-01-01T00:00:00Z old\n2030-01-01T00:00:00Z new\n");
    const since = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const events = await runFinite(
      followLogSource({
        service: SERVICE,
        source: source({ timestamps: true }),
        follow: false,
        since,
        access: fs.access,
      }),
    );
    expect(lines(events)).toEqual(["new"]);
  });
});

const collectFollow = (
  build: (
    fs: ReturnType<typeof makeMemoryLogFileAccess>,
  ) => Stream.Stream<LogFollowEvent, ProviderError, never>,
  drive: (
    fs: ReturnType<typeof makeMemoryLogFileAccess>,
    adjust: (millis: number) => Effect.Effect<void>,
    read: Effect.Effect<ReadonlyArray<LogFollowEvent>>,
  ) => Effect.Effect<ReadonlyArray<LogFollowEvent>>,
): Promise<{ readonly events: ReadonlyArray<LogFollowEvent>; readonly handles: number }> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = makeMemoryLogFileAccess();
      const ref = yield* Ref.make<ReadonlyArray<LogFollowEvent>>([]);
      const fiber = yield* Effect.fork(
        Effect.scoped(Stream.runForEach(build(fs), (event) => Ref.update(ref, (prev) => [...prev, event]))),
      );
      const adjust = (millis: number) => TestClock.adjust(Duration.millis(millis));
      yield* adjust(1);
      const events = yield* drive(fs, adjust, Ref.get(ref));
      yield* Fiber.interrupt(fiber);
      const handles = fs.openHandleCount();
      return { events, handles };
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

describe("followLogSource follow (§6.14.4)", () => {
  test("S2 backfills tail then follows appended writes", async () => {
    const { events, handles } = await collectFollow(
      (fs) => {
        fs.writeFile("/var/log/mysql/slow.log", "b1\nb2\n");
        return followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          tail: 1,
          access: fs.access,
          pollIntervalMillis: 100,
        });
      },
      (fs, adjust, read) =>
        Effect.gen(function* () {
          fs.appendFile("/var/log/mysql/slow.log", "b3\n");
          yield* adjust(100);
          fs.appendFile("/var/log/mysql/slow.log", "b4\n");
          yield* adjust(100);
          return yield* read;
        }),
    );
    expect(lines(events)).toEqual(["b2", "b3", "b4"]);
    expect(handles).toBe(0);
  });

  test("S2 flushes a final partial line during initial follow backfill", async () => {
    const { events, handles } = await collectFollow(
      (fs) => {
        fs.writeFile("/var/log/mysql/slow.log", "b1\npartial");
        return followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
        });
      },
      (_fs, _adjust, read) => read,
    );

    expect(lines(events)).toEqual(["b1", "partial"]);
    expect(handles).toBe(0);
  });

  test("S3 missing follow file emits pending then follows once it appears", async () => {
    const { events } = await collectFollow(
      (fs) =>
        followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
          readinessTimeoutMillis: 10_000,
        }),
      (fs, adjust, read) =>
        Effect.gen(function* () {
          yield* adjust(100);
          fs.writeFile("/var/log/mysql/slow.log", "arrived\n");
          yield* adjust(100);
          yield* adjust(100);
          return yield* read;
        }),
    );
    expect(diagnostics(events)).toContain("pending");
    expect(lines(events)).toContain("arrived");
  });

  test("S3 missing follow file times out to unavailable", async () => {
    const { events } = await collectFollow(
      (fs) =>
        followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
          readinessTimeoutMillis: 500,
        }),
      (_fs, adjust, read) =>
        Effect.gen(function* () {
          for (let i = 0; i < 8; i += 1) yield* adjust(100);
          return yield* read;
        }),
    );
    expect(diagnostics(events)).toEqual(["pending", "unavailable"]);
  });

  test("S3 missing required follow file fails after readiness timeout", async () => {
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = makeMemoryLogFileAccess();
        const fiber = yield* Effect.fork(
          Effect.scoped(
            Stream.runDrain(
              followLogSource({
                service: SERVICE,
                source: source({ required: true }),
                follow: true,
                access: fs.access,
                pollIntervalMillis: 100,
                readinessTimeoutMillis: 500,
              }),
            ),
          ),
        );
        for (let i = 0; i < 8; i += 1) yield* TestClock.adjust(Duration.millis(100));
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expectProviderUnavailable(exit);
  });

  test("S4 survives rename+create rotation and emits a rotation marker", async () => {
    const { events } = await collectFollow(
      (fs) => {
        fs.writeFile("/var/log/mysql/slow.log", "old1\n");
        return followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
        });
      },
      (fs, adjust, read) =>
        Effect.gen(function* () {
          fs.appendFile("/var/log/mysql/slow.log", "old2\n");
          yield* adjust(100);
          fs.rotateRenameCreate("/var/log/mysql/slow.log", "new1\n");
          yield* adjust(100);
          fs.appendFile("/var/log/mysql/slow.log", "new2\n");
          yield* adjust(100);
          return yield* read;
        }),
    );
    expect(lines(events)).toEqual(["old1", "old2", "new1", "new2"]);
    expect(diagnostics(events)).toContain("rotated");
  });

  test("S5 survives copytruncate without duplicating drained lines", async () => {
    const { events } = await collectFollow(
      (fs) => {
        fs.writeFile("/var/log/mysql/slow.log", "a1\na2\n");
        return followLogSource({
          service: SERVICE,
          source: source(),
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
        });
      },
      (fs, adjust, read) =>
        Effect.gen(function* () {
          yield* adjust(100);
          fs.copyTruncate("/var/log/mysql/slow.log", "a3\n");
          yield* adjust(100);
          return yield* read;
        }),
    );
    expect(lines(events)).toEqual(["a1", "a2", "a3"]);
    expect(diagnostics(events)).toContain("truncated");
  });
});

describe("followLogSources merge + lifecycle (§6.14.4)", () => {
  test("S8 merges only follow sources and honors the source filter", async () => {
    const fs = makeMemoryLogFileAccess();
    fs.writeFile("/a.log", "a\n");
    fs.writeFile("/b.log", "b\n");
    const sources = [
      source({ id: "a", path: "/a.log" }),
      source({ id: "b", path: "/b.log" }),
      source({ id: "r", path: "/r.log", strategy: "redirect" }),
    ];
    const events = await runFinite(
      followLogSources({
        service: SERVICE,
        sources,
        follow: false,
        access: fs.access,
        source: "a" as never,
      }),
    );
    expect(lines(events)).toEqual(["a"]);
  });

  test("S9 reaps every follower handle on interrupt (>=6 services x >=3 sources)", async () => {
    const { handles } = await collectFollow(
      (fs) => {
        const sources = [];
        for (let svc = 0; svc < 6; svc += 1) {
          for (let src = 0; src < 3; src += 1) {
            const path = `/svc${svc}-src${src}.log`;
            fs.writeFile(path, "seed\n");
            sources.push(source({ id: `svc${svc}-src${src}`, path }));
          }
        }
        return followLogSources({
          service: SERVICE,
          sources,
          follow: true,
          access: fs.access,
          pollIntervalMillis: 100,
        });
      },
      (_fs, adjust, read) =>
        Effect.gen(function* () {
          yield* adjust(100);
          return yield* read;
        }),
    );
    expect(handles).toBe(0);
  });
});
