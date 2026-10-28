import { describe, expect, test } from "bun:test";
import { ContainerHelperUnavailableError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { CommandSpec, ExecChunk } from "@lando/sdk/services";
import { Cause, DateTime, Duration, Effect, Exit, Fiber, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { EngineHttpApi, EngineHttpRequest } from "../src/engine-api.ts";
import { execStream } from "../src/podman/exec.ts";
import { installSupervisedExecFixture, supervisedExecFixtureOptions } from "./support/exec-supervision.ts";

const ctx = { providerId: "docker", remediation: "Retry.", env: {} };
const service = ServiceName.make("web");
const app = AppId.make("supervision-races");
const provider = ProviderId.make("docker");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
  source: "exec-supervision.test.ts",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: app,
  name: "Supervision races",
  slug: "supervision-races",
  root: AbsolutePath.make("/tmp/supervision-races"),
  provider,
  services: {
    [service]: {
      name: service,
      type: "node",
      provider,
      primary: true,
      artifact: { kind: "ref", ref: "node:22-alpine" },
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};
const target = { app, service, user: "1000:1000" };
const providerFailure = (message: string) =>
  new ProviderUnavailableError({ ...ctx, operation: "exec", message });
const frame = (value: string) => {
  const payload = new TextEncoder().encode(value);
  const result = new Uint8Array(payload.length + 8);
  result[0] = 1;
  new DataView(result.buffer).setUint32(4, payload.length);
  result.set(payload, 8);
  return result;
};
type Stage =
  | "init-create"
  | "init-start"
  | "primary-create"
  | "primary-start"
  | "ready"
  | "launch"
  | "watch-inspect"
  | "watch-create"
  | "watch"
  | "status"
  | "cancel"
  | "collect"
  | "cleanup";
interface Hooks {
  readonly before?: (stage: Stage, input: EngineHttpRequest) => Effect.Effect<void, ProviderUnavailableError>;
  readonly replaceStream?: (
    stage: Stage,
    input: EngineHttpRequest,
  ) => Stream.Stream<Uint8Array, ProviderUnavailableError> | undefined;
  readonly mainError?: ProviderUnavailableError;
  readonly exitCode?: number;
  readonly noOutput?: boolean;
  readonly watchRunningReplies?: number;
  readonly watchBeforeEOF?: Promise<void>;
  readonly onWatchTerminal?: () => void;
  readonly watchTrailingBytes?: Uint8Array;
  readonly watchReadyTrailingBytes?: Uint8Array;
}
const fixture = (hooks: Hooks = {}) => {
  const requests: EngineHttpRequest[] = [];
  const observedChunks: ExecChunk[] = [];
  const events: Stage[] = [];
  const commands = new Map<string, readonly string[]>();
  let primaryStarts = 0;
  let launches = 0;
  let watchPulses = 0;
  const endedWatches = new Set<string>();
  const pulseWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  const eventWaiters: Array<{ readonly stage: Stage; readonly resolve: () => void }> = [];
  const recordEvent = (stage: Stage): void => {
    events.push(stage);
    for (const waiter of eventWaiters) if (waiter.stage === stage) waiter.resolve();
  };
  const recordPulse = (): void => {
    watchPulses++;
    for (const waiter of pulseWaiters) if (watchPulses >= waiter.count) waiter.resolve();
  };
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.sync(() => {
        if (input.method === "GET" && input.path.startsWith("/containers/") && input.path.endsWith("/json"))
          return { status: 200, body: JSON.stringify({ Id: "immutable-container-id" }) };
        if (input.method === "POST" && input.path.endsWith("/exec"))
          return { status: 201, body: JSON.stringify({ Id: "primary-exec-id" }) };
        if (input.path === "/exec/primary-exec-id/json")
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: hooks.exitCode ?? 0 }) };
        return { status: 500, body: "unexpected fake engine request" };
      }),
    stream: (input) =>
      Stream.suspend(() => {
        input.onResponseHead?.();
        return hooks.mainError === undefined
          ? hooks.noOutput === true
            ? Stream.empty
            : Stream.make(frame("command output\n"))
          : Stream.fail(hooks.mainError);
      }),
  };
  installSupervisedExecFixture(api);
  const request = api.request;
  const stream = api.stream;
  if (request === undefined || stream === undefined) throw new TypeError("Missing fixture transport.");
  const stageFor = (cmd: readonly string[] | undefined, starting: boolean): Stage | undefined => {
    if (cmd?.[1] === "exec-init") return starting ? "init-start" : "init-create";
    if (cmd?.[1] === "exec-supervisor") return starting ? "primary-start" : "primary-create";
    if (cmd?.[1] === "exec-cleanup") return starting ? "cleanup" : undefined;
    if (cmd?.[1] === "exec-control" && cmd[4] === "watch" && !starting) return "watch-create";
    if (starting && cmd?.[1] === "exec-control") return cmd[4] as Stage;
    return undefined;
  };
  Object.assign(api, {
    request: (input: EngineHttpRequest) =>
      Effect.gen(function* () {
        requests.push(input);
        const cmd = (input.body as { Cmd?: readonly string[] } | undefined)?.Cmd;
        const inspectId = /^\/exec\/([^/]+)\/json$/u.exec(input.path)?.[1];
        const inspectedCmd = inspectId === undefined ? undefined : commands.get(inspectId);
        const stage =
          stageFor(cmd, false) ??
          (inspectedCmd?.[1] === "exec-control" && inspectedCmd[4] === "watch" ? "watch-inspect" : undefined);
        if (stage !== undefined) {
          recordEvent(stage);
          yield* hooks.before?.(stage, input) ?? Effect.void;
        }
        const response = yield* request(input);
        if (inspectId !== undefined && endedWatches.has(inspectId))
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: 0 }) };
        if (cmd !== undefined && response.status < 300)
          commands.set((JSON.parse(response.body) as { Id: string }).Id, cmd);
        return response;
      }),
    stream: (input: EngineHttpRequest) =>
      Stream.unwrap(
        Effect.gen(function* () {
          requests.push(input);
          const id = /^\/exec\/([^/]+)\/start$/u.exec(input.path)?.[1];
          const stage = stageFor(id === undefined ? undefined : commands.get(id), true);
          if (stage !== undefined) {
            recordEvent(stage);
            yield* hooks.before?.(stage, input) ?? Effect.void;
            const replacement = hooks.replaceStream?.(stage, input);
            if (replacement !== undefined) return replacement;
            if (stage === "primary-start") primaryStarts++;
            if (stage === "launch") launches++;
            if (stage === "watch" && hooks.watchRunningReplies !== undefined) {
              return Stream.fromAsyncIterable(
                {
                  async *[Symbol.asyncIterator]() {
                    input.onResponseHead?.();
                    let pending = "";
                    let runningReplies = 0;
                    let previousSeq = 0;
                    for await (const chunk of input.stdin ?? []) {
                      pending += new TextDecoder().decode(chunk);
                      for (
                        let newline = pending.indexOf("\n");
                        newline >= 0;
                        newline = pending.indexOf("\n")
                      ) {
                        const pulse = JSON.parse(pending.slice(0, newline)) as { op?: string; seq?: number };
                        pending = pending.slice(newline + 1);
                        if (
                          pulse.op !== "status" ||
                          typeof pulse.seq !== "number" ||
                          !Number.isSafeInteger(pulse.seq) ||
                          pulse.seq <= previousSeq
                        )
                          throw new Error("Unexpected watch pulse.");
                        previousSeq = pulse.seq;
                        recordPulse();
                        if (launches === 0) {
                          const ready = frame(
                            `${JSON.stringify({ ok: true, seq: pulse.seq, state: "ready" })}\n`,
                          );
                          yield hooks.watchReadyTrailingBytes === undefined
                            ? ready
                            : Buffer.concat([ready, hooks.watchReadyTrailingBytes]);
                          if (hooks.watchReadyTrailingBytes !== undefined) {
                            if (id !== undefined) endedWatches.add(id);
                            return;
                          }
                          continue;
                        }
                        if (runningReplies++ < (hooks.watchRunningReplies ?? 0)) {
                          yield frame(`${JSON.stringify({ ok: true, seq: pulse.seq, state: "running" })}\n`);
                          continue;
                        }
                        hooks.onWatchTerminal?.();
                        yield frame(
                          `${JSON.stringify({ ok: true, seq: pulse.seq, state: "finished", exitCode: hooks.exitCode ?? 0, joined: true })}\n`,
                        );
                        if (hooks.watchTrailingBytes !== undefined) yield hooks.watchTrailingBytes;
                        if (hooks.watchBeforeEOF !== undefined) await hooks.watchBeforeEOF;
                        if (id !== undefined) endedWatches.add(id);
                        return;
                      }
                    }
                    if (id !== undefined) endedWatches.add(id);
                  },
                },
                () => providerFailure("controlled-watch-failed"),
              );
            }
          }
          return stream(input);
        }),
      ),
  });
  const runEffect = (controller?: AbortController, extra: Partial<CommandSpec> = {}) => {
    const chunks = observedChunks;
    const effect = execStream(
      plan,
      target,
      {
        command: ["test-command"],
        raw: true,
        tty: false,
        ...(controller === undefined ? {} : { signal: controller.signal }),
        ...extra,
      },
      { api, ctx, ...supervisedExecFixtureOptions(api) },
    ).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          chunks.push(chunk);
        }),
      ),
      Effect.scoped,
      Effect.exit,
    );
    return effect.pipe(Effect.map((exit) => ({ exit, chunks })));
  };
  const run = (controller?: AbortController, extra: Partial<CommandSpec> = {}) =>
    Effect.runPromise(runEffect(controller, extra));
  const waitForPulses = (count: number) =>
    watchPulses >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => pulseWaiters.push({ count, resolve }));
  const waitForEvent = (stage: Stage) =>
    events.includes(stage)
      ? Promise.resolve()
      : new Promise<void>((resolve) => eventWaiters.push({ stage, resolve }));
  return {
    api,
    requests,
    events,
    run,
    runEffect,
    waitForPulses,
    waitForEvent,
    pulseCount: () => watchPulses,
    chunks: observedChunks,
    counts: () => ({ primaryStarts, launches }),
  };
};
const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
const terminalChunks = (chunks: readonly ExecChunk[]) => chunks.filter((chunk) => "exitCode" in chunk);

describe("non-TTY exec supervision lifecycle", () => {
  test.each([0, 7, 143])(
    "preserves immediate command exit %s only after joining and cleanup",
    async (exitCode) => {
      const f = fixture({ exitCode });
      const { exit, chunks } = await f.run();
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(terminalChunks(chunks)).toEqual([{ exitCode }]);
      expect(f.events).toContain("watch");
      expect(f.events).toContain("collect");
      expect(f.events).toContain("cleanup");
      expect(f.counts()).toEqual({ primaryStarts: 1, launches: 1 });
      const actions = f.requests.filter(
        (request) => request.path.startsWith("/containers/") && !request.path.endsWith("/json"),
      );
      expect(actions.every((request) => request.path.startsWith("/containers/immutable-container-id/"))).toBe(
        true,
      );
      const creates = actions.filter((request) => request.path.endsWith("/exec"));
      expect(creates.every((request) => (request.body as { User?: string }).User === target.user)).toBe(true);
      const watch = creates.find(
        (request) => (request.body as { Cmd?: readonly string[] }).Cmd?.[4] === "watch",
      );
      expect(watch?.body).toMatchObject({ AttachStdin: true, AttachStdout: true, Tty: false });
    },
  );

  test("pre-aborted commands issue no provider actions or terminal status", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort("SIGINT");
    const { exit, chunks } = await f.run(controller);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(f.requests).toHaveLength(0);
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts()).toEqual({ primaryStarts: 0, launches: 0 });
  });

  test.each([
    "init-create",
    "init-start",
    "primary-create",
    "primary-start",
    "ready",
    "watch-create",
    "watch",
    "launch",
  ] as const)(
    "cancellation during %s cannot release the child or report terminal success",
    async (stopAt) => {
      const controller = new AbortController();
      let intercepted = false;
      const f = fixture({
        before: (stage) =>
          stage === stopAt && !intercepted
            ? Effect.sync(() => {
                intercepted = true;
                controller.abort("SIGINT");
              }).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const { exit, chunks } = await f.run(controller);
      expect(intercepted).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(terminalChunks(chunks)).toHaveLength(0);
      expect(f.counts().launches).toBe(0);
      expect(f.events).toContain("cancel");
      if (stopAt === "watch") {
        expect(failureText(exit)).toContain("cleanup-unconfirmed");
        expect(f.events).not.toContain("cleanup");
      } else {
        expect(f.events).toContain("collect");
        if (stopAt === "watch-create") {
          expect(failureText(exit)).not.toContain("cleanup-unconfirmed");
          expect(f.events).toContain("cleanup");
        }
      }
      const cancel = f.requests.find((request) => {
        const cmd = (request.body as { Cmd?: readonly string[] } | undefined)?.Cmd;
        return cmd?.[1] === "exec-control" && cmd[4] === "cancel";
      });
      expect((cancel?.body as { Cmd?: readonly string[] } | undefined)?.Cmd?.[5]).toBe("SIGINT");
      if (stopAt === "primary-create" || stopAt === "primary-start")
        expect(failureText(exit)).toContain("cleanup-unconfirmed");
    },
    25_000,
  );

  test("preserves a genuine primary attach failure through successful cleanup", async () => {
    const error = providerFailure("distinct-primary-transport-failure");
    const f = fixture({ mainError: error });
    const { exit, chunks } = await f.run();
    expect(failureText(exit)).toContain(error.message);
    expect(failureText(exit)).not.toContain("cleanup-unconfirmed");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).toContain("cancel");
    expect(f.events).toContain("cleanup");
  });

  test("a missing completion receipt cannot produce terminal success", async () => {
    let missing = false;
    const f = fixture({
      replaceStream: (stage) => {
        if (stage !== "watch" || missing) return undefined;
        missing = true;
        return Stream.empty;
      },
    });
    const { exit, chunks } = await f.run();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("watch");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).toContain("cancel");
  });

  test("a provider error before START preserves failure and blocks the child", async () => {
    const error = providerFailure("distinct-init-control-failure");
    const f = fixture({ before: (stage) => (stage === "init-create" ? Effect.fail(error) : Effect.void) });
    const { exit, chunks } = await f.run();
    expect(failureText(exit)).toContain(error.message);
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts()).toEqual({ primaryStarts: 0, launches: 0 });
    expect(f.events).toContain("cancel");
    expect(f.events).toContain("cleanup");
  });

  test("an unconfirmed cleanup remains an explicit failure beside the primary failure", async () => {
    const f = fixture({
      mainError: providerFailure("primary-error-before-uncertain-cleanup"),
      before: (stage) => {
        return stage === "cancel" || stage === "status"
          ? Effect.fail(providerFailure("cleanup-channel-down"))
          : Effect.void;
      },
    });
    const { exit, chunks } = await f.run();
    const text = failureText(exit);
    expect(text).toContain("primary-error-before-uncertain-cleanup");
    expect(text).toContain("cleanup-unconfirmed");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).not.toContain("cleanup");
  }, 25_000);

  test("hundreds of acknowledged heartbeats use one persistent control exec", async () => {
    const f = fixture({ watchRunningReplies: 200, noOutput: true });
    const countCreates = () =>
      f.requests.filter((request) => {
        if (request.method !== "POST" || !request.path.endsWith("/exec")) return false;
        const cmd = (request.body as { Cmd?: readonly string[] }).Cmd;
        // Collection and session removal happen after the steady observation interval.
        return cmd?.[1] !== "exec-cleanup" && cmd?.[4] !== "collect";
      }).length;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.runEffect());
        yield* Effect.promise(() => f.waitForEvent("ready"));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.promise(() => f.waitForPulses(1));
        yield* TestClock.adjust(Duration.millis(500));
        yield* Effect.promise(() => f.waitForPulses(2));
        expect(f.pulseCount()).toBe(2);
        const steadyCreates = countCreates();
        for (let pulse = 3; pulse <= 201; pulse++) {
          yield* TestClock.adjust(Duration.millis(500));
          yield* Effect.promise(() => f.waitForPulses(pulse));
          expect(f.pulseCount()).toBe(pulse);
          expect(countCreates()).toBe(steadyCreates);
        }
        yield* TestClock.adjust(Duration.millis(500));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(Exit.isSuccess(result.exit)).toBe(true);
    expect(terminalChunks(result.chunks)).toEqual([{ exitCode: 0 }]);
    expect(f.pulseCount()).toBe(202);
    const operations = f.requests
      .filter((request) => request.method === "POST" && request.path.endsWith("/exec"))
      .map((request) => (request.body as { Cmd?: readonly string[] }).Cmd?.[4]);
    expect(operations.filter((operation) => operation === "watch")).toHaveLength(1);
    expect(operations.filter((operation) => operation === "status")).toHaveLength(0);
    expect(result.chunks.filter((chunk) => "kind" in chunk)).toHaveLength(0);
  }, 10_000);

  test("a command producing no output completes through its watched receipt", async () => {
    const f = fixture({ noOutput: true, exitCode: 23 });
    const { exit, chunks } = await f.run();
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(chunks).toEqual([{ exitCode: 23 }]);
    expect(f.events.filter((stage) => stage === "watch")).toHaveLength(1);
    expect(f.events.filter((stage) => stage === "status")).toHaveLength(0);
  });

  test("loss of heartbeat acknowledgement fails before launching an unmonitored command", async () => {
    const f = fixture({
      noOutput: true,
      replaceStream: (stage, input) =>
        stage === "watch"
          ? Stream.suspend(() => {
              input.onResponseHead?.();
              return Stream.never;
            })
          : undefined,
    });
    const { exit, chunks } = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.runEffect());
        yield* Effect.promise(() => f.waitForEvent("ready"));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.promise(() => f.waitForEvent("watch"));
        yield* TestClock.adjust(Duration.seconds(15));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("watch");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts().launches).toBe(0);
    expect(f.events).toContain("cancel");
  }, 10_000);

  test("heartbeat acknowledgement loss after launch cannot fabricate command completion", async () => {
    let markRunning: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const f = fixture({
      noOutput: true,
      replaceStream: (stage, input) => {
        if (stage !== "watch") return undefined;
        const replies = Stream.fromAsyncIterable(
          {
            async *[Symbol.asyncIterator]() {
              input.onResponseHead?.();
              let pending = "";
              let replies = 0;
              for await (const chunk of input.stdin ?? []) {
                pending += new TextDecoder().decode(chunk);
                for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
                  const pulse = JSON.parse(pending.slice(0, newline)) as { seq: number };
                  pending = pending.slice(newline + 1);
                  yield frame(
                    `${JSON.stringify({ ok: true, seq: pulse.seq, state: replies++ === 0 ? "ready" : "running" })}\n`,
                  );
                  if (replies === 2) {
                    markRunning();
                    return;
                  }
                }
              }
            },
          },
          () => providerFailure("watch-pulse-read-failed"),
        );
        return Stream.concat(replies, Stream.never);
      },
    });
    const { exit, chunks } = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(f.runEffect());
        yield* Effect.promise(() => f.waitForEvent("ready"));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.promise(() => f.waitForEvent("watch"));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.promise(() => running);
        yield* TestClock.adjust(Duration.seconds(15));
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("watch");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.counts().launches).toBe(1);
    expect(f.events).toContain("cancel");
    expect(f.events).toContain("collect");
  }, 10_000);

  test("terminal watch receipt waits for EOF and the watcher exit inspection", async () => {
    let releaseEOF: () => void = () => undefined;
    const beforeEOF = new Promise<void>((resolve) => {
      releaseEOF = resolve;
    });
    let markTerminal: () => void = () => undefined;
    const terminal = new Promise<void>((resolve) => {
      markTerminal = resolve;
    });
    let releaseInspect: () => void = () => undefined;
    const beforeInspect = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });
    let markInspect: () => void = () => undefined;
    const inspecting = new Promise<void>((resolve) => {
      markInspect = resolve;
    });
    const f = fixture({
      watchRunningReplies: 0,
      watchBeforeEOF: beforeEOF,
      onWatchTerminal: markTerminal,
      before: (stage) =>
        stage === "watch-inspect"
          ? Effect.sync(markInspect).pipe(Effect.andThen(Effect.promise(() => beforeInspect)))
          : Effect.void,
    });
    const pending = f.run();
    try {
      await terminal;
      expect(terminalChunks(f.chunks)).toHaveLength(0);
      expect(f.events).not.toContain("collect");
      expect(f.events).not.toContain("watch-inspect");
      releaseEOF();
      await inspecting;
      expect(terminalChunks(f.chunks)).toHaveLength(0);
      expect(f.events).not.toContain("collect");
      releaseInspect();
      const { exit, chunks } = await pending;
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(terminalChunks(chunks)).toEqual([{ exitCode: 0 }]);
      expect(f.events.indexOf("collect")).toBeGreaterThan(f.events.indexOf("watch-inspect"));
    } finally {
      releaseEOF();
      releaseInspect();
    }
  });

  test("a valid terminal receipt followed by a partial Docker header cannot report success", async () => {
    const f = fixture({ watchRunningReplies: 0, watchTrailingBytes: new Uint8Array([1, 0, 0]) });
    const { exit, chunks } = await f.run();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureText(exit)).toContain("watch");
    expect(terminalChunks(chunks)).toHaveLength(0);
    expect(f.events).toContain("cancel");
  });

  test.each([new Uint8Array([1, 0, 0]), new Uint8Array([9, 0, 0, 0, 0, 0, 0, 1, 0])])(
    "a READY receipt followed by an invalid Docker header cannot launch the command %s",
    async (trailing) => {
      const f = fixture({ watchRunningReplies: 0, watchReadyTrailingBytes: trailing });
      const { exit, chunks } = await f.run();
      expect(Exit.isFailure(exit)).toBe(true);
      expect(f.counts().launches).toBe(0);
      expect(terminalChunks(chunks)).toHaveLength(0);
      expect(failureText(exit)).toContain("watch");
      expect(f.events).toContain("cancel");
    },
    10_000,
  );

  test("missing helper capabilities fail closed before issuing a process", async () => {
    const f = fixture();
    const exit = await Effect.runPromiseExit(
      execStream(plan, target, { command: ["test-command"], raw: true }, { api: f.api, ctx }).pipe(
        Stream.runDrain,
        Effect.scoped,
      ),
    );
    expect(failureText(exit)).toContain("helper-unavailable");
    expect(f.requests).toHaveLength(0);
  });

  test("unsupported helper resolution retains its actionable error and never starts a process", async () => {
    const f = fixture();
    const exit = await Effect.runPromiseExit(
      execStream(
        plan,
        target,
        { command: ["test-command"], raw: true },
        {
          api: f.api,
          ctx,
          helperTarget: { os: "linux", arch: "x64" },
          resolveContainerHelper: (helperTarget) =>
            Effect.fail(
              new ContainerHelperUnavailableError({
                target: helperTarget,
                message: "Helper architecture unsupported.",
                remediation: "Select a supported architecture.",
              }),
            ),
        },
      ).pipe(Stream.runDrain, Effect.scoped),
    );
    expect(failureText(exit)).toContain("Helper architecture unsupported.");
    if (Exit.isSuccess(exit)) throw new Error("Unsupported helper unexpectedly executed.");
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause)).remediation).toBe(
      "Select a supported architecture.",
    );
    expect(f.events).toHaveLength(0);
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });
});
