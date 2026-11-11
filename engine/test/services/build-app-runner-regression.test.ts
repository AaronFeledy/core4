import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { ProviderInternalError, SecretStoreUnavailableError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import type { ExecTarget, RuntimeProviderShape } from "@lando/sdk/services";
import { BuildOrchestrator, EventService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";

test("waits for an app-step dependency before dispatching its dependent", async () => {
  await withTempRoots(async () => {
    // Given
    const calls: string[] = [];
    let prepareCompleted = false;
    let installStartedAfterPrepare = false;
    const provider = {
      ...TestRuntimeProvider,
      execStream: (_target: unknown, command: { readonly command: ReadonlyArray<string> }) => {
        const name = command.command[0] ?? "missing";
        calls.push(name);
        if (name === "prepare") {
          return Stream.fromEffect(
            Effect.sleep("20 millis").pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  prepareCompleted = true;
                }),
              ),
              Effect.as({ exitCode: 0 }),
            ),
          );
        }
        installStartedAfterPrepare = prepareCompleted;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(calls).toEqual(["prepare", "install"]);
    expect(installStartedAfterPrepare).toBe(true);
  });
});

test("aggregates a provider stream error after healthy app siblings settle", async () => {
  await withTempRoots(async () => {
    // Given
    const completed: string[] = [];
    const failure = new ProviderInternalError({
      providerId,
      operation: "execStream",
      message: "synthetic provider stream failure",
      remediation:
        "Re-run the command after checking provider logs; if it persists, report the internal provider error.",
    });
    const provider = {
      ...TestRuntimeProvider,
      execStream: (target: { readonly service: ServiceName }) =>
        target.service === ServiceName.make("node")
          ? Stream.fail(failure)
          : Stream.fromEffect(
              Effect.sleep("20 millis").pipe(
                Effect.tap(() => Effect.sync(() => void completed.push(String(target.service)))),
                Effect.as({ exitCode: 0 }),
              ),
            ),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      node: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.buildApp(plan));
          return { error, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(completed).toEqual(["web"]);
    expect(result.error).toMatchObject({ _tag: "BuildPhaseFailedError", phase: "app" });
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    expect(result.error.failures).toHaveLength(1);
    expect(result.error.failures[0]).toMatchObject({
      _tag: "BuildStepFailedError",
      step: { service: ServiceName.make("node") },
      cause: { _tag: "ProviderInternalError" },
      remediation: failure.remediation,
    });
    const stepFailure = result.error.failures[0];
    expect(stepFailure?.exitCode).toBeUndefined();
    expect(stepFailure?.message).toContain("synthetic provider stream failure");
    expect(stepFailure?.message).not.toBe("An internal Lando error occurred.");
    expect(stepFailure?.outputTail).toBeUndefined();
    const failEvent = result.events.find(
      (event) => event._tag === "task.fail" && event.taskId === "node:app:install",
    );
    if (failEvent?._tag !== "task.fail") throw new TypeError("failed step task event is missing");
    expect(failEvent.exitCode).toBeUndefined();
    const failedStart = result.events.find(
      (event) => event._tag === "task.start" && event.taskId === "node:app:install",
    );
    if (failedStart?._tag !== "task.start") throw new TypeError("failed step start event is missing");
    expect(await readFile(String(failedStart.transcriptPath), "utf8")).toContain(
      "Error: synthetic provider stream failure",
    );
    expect(result.events.filter((event) => event._tag === "task.fail")).toHaveLength(1);
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      succeeded: 1,
      failed: 1,
    });
  });
});

test("settles started app tasks when the build fiber is interrupted", async () => {
  await withTempRoots(async () => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.never,
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const fiber = yield* Effect.forkChild(orchestrator.buildApp(plan));
          yield* eventService.waitFor("task.start");
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
          else throw new TypeError("interrupted build unexpectedly succeeded");
          return [...(yield* Queue.clear(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const starts = events.filter((event) => event._tag === "task.start");
    expect(starts).toHaveLength(2);
    const started = starts.find((event) => event.taskId === "web:app:prepare");
    const neverStarted = starts.find((event) => event.taskId === "web:app:install");
    expect(started?._tag).toBe("task.start");
    expect(neverStarted?._tag).toBe("task.start");
    if (started?._tag === "task.start") expect(started.transcriptPath).toBeDefined();
    // A step settled on interrupt before dispatch advertises no transcript.
    if (neverStarted?._tag === "task.start") expect(neverStarted.transcriptPath).toBeUndefined();
    expect(events.filter((event) => event._tag === "task.fail")).toHaveLength(2);
    expect(events.filter((event) => event._tag === "task.tree.complete")).toHaveLength(1);
  });
});

test("reports an already-aborted build signal as interruption", async () => {
  await withTempRoots(async () => {
    // Given
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.never,
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });
    const controller = new AbortController();
    controller.abort();

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const exit = yield* Effect.exit(orchestrator.buildApp(plan, { signal: controller.signal }));
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    else throw new TypeError("aborted build unexpectedly succeeded");
    expect(result.events.find((event) => event._tag === "task.tree.complete")).toMatchObject({
      summary: "App dependency build interrupted",
    });
  });
});

test("bounds unterminated task detail and writes the same bounded line to the transcript", async () => {
  await withTempRoots(async () => {
    // Given
    const output = "x".repeat(128 * 1024);
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(output) }, { exitCode: 0 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.buildApp(plan);
          return [...(yield* Queue.clear(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const detail = result.find((event) => event._tag === "task.detail");
    expect(detail).toBeDefined();
    if (detail?._tag !== "task.detail") throw new TypeError("task detail event is missing");
    const detailLine = detail.line;
    if (typeof detailLine !== "string") throw new TypeError("task detail line is not text");
    expect(new TextEncoder().encode(detailLine).byteLength).toBeLessThanOrEqual(65_560);
    expect(detailLine).toEndWith("…[truncated]");
    const start = result.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
    expect(await readFile(String(start.transcriptPath), "utf8")).toBe(`${detailLine}\n`);
  });
});

test("forwards BuildStep.user on the execStream ExecTarget and omits it when absent", async () => {
  await withTempRoots(async () => {
    // Given
    const targets: Array<ExecTarget> = [];
    const provider = {
      ...TestRuntimeProvider,
      execStream: (target: ExecTarget) => {
        targets.push(target);
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const withUser = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] }, user: "node" }],
    });
    const withoutUser = planWith({
      node: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(withUser)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(withoutUser)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      app: withUser.id,
      service: ServiceName.make("web"),
      user: "node",
    });
    expect(targets[1]).toMatchObject({
      app: withoutUser.id,
      service: ServiceName.make("node"),
    });
    expect("user" in (targets[1] ?? {})).toBe(false);
  });
});

test("redacts transcript and detail events for a build.app step with no secret reference in the plan", async () => {
  await withTempRoots(async () => {
    // Given: proxy credentials arrive through an ordinary plan environment value, not a secret reference.
    const password = "proxypass-hunter2";
    const username = "proxyuser";
    const proxyUrl = `http://${username}:${password}@127.0.0.1:3128`;
    const plan = planWith(
      { web: [{ id: "install", phase: "app", command: { command: ["install"] } }] },
      { web: { environment: { HTTP_PROXY: proxyUrl } } },
    );
    const output = `proxy=${proxyUrl}\nbare=${password}\nunterminated=${password}`;
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make({ kind: "stdout" as const, chunk: new TextEncoder().encode(output) }, { exitCode: 0 }),
    } satisfies RuntimeProviderShape;

    // When
    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const eventService = yield* EventService;
          const queue = yield* eventService.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          yield* orchestrator.buildApp(plan);
          return [...(yield* Queue.clear(queue))];
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    const start = events.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
    const transcript = await readFile(String(start.transcriptPath), "utf8");
    expect(transcript).toContain("[redacted]");
    expect(transcript).not.toContain(password);
    expect(transcript).not.toContain(username);
    expect(transcript).toContain("unterminated=");
    const details = events.filter((event) => event._tag === "task.detail");
    expect(details.map((detail) => detail.line)).toEqual([
      expect.stringMatching(/^proxy=.*\[redacted\]/u),
      "bare=[redacted]",
      "unterminated=[redacted]",
    ]);
    for (const detail of details) {
      expect(detail.line).not.toContain(password);
      expect(detail.line).not.toContain(username);
    }
    expect(JSON.stringify(details)).toContain("[redacted]");
  });
});

test("reports an ordinary nonzero exit with its code and a transcript error line", async () => {
  await withTempRoots(async () => {
    // Given a step stream whose command exits 7 after printing output that ends without a newline.
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode("partial output\nunterminated") },
          { exitCode: 7 },
        ),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.buildApp(plan));
          return { error, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(result.error._tag).toBe("BuildPhaseFailedError");
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    const stepFailure = result.error.failures[0];
    expect(stepFailure).toMatchObject({
      step: { service: ServiceName.make("web") },
      exitCode: 7,
      message: "Build step web:app:install for service web exited with code 7.",
      outputTail: "partial output\nunterminated",
    });
    const start = result.events.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
    const transcript = await readFile(String(start.transcriptPath), "utf8");
    expect(start.transcriptPath).toBe(stepFailure?.transcriptPath);
    expect(transcript).toBe(
      "partial output\nunterminated\nError: Build step web:app:install for service web exited with code 7.\n",
    );
  });
});

test("a blocked step carries no exit code", async () => {
  await withTempRoots(async () => {
    // Given a predecessor that exits nonzero and a dependent step.
    const provider = {
      ...TestRuntimeProvider,
      execStream: (_target: unknown, command: { readonly command: ReadonlyArray<string> }) =>
        Stream.make({ exitCode: command.command[0] === "prepare" ? 3 : 0 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [
        { id: "prepare", phase: "app", command: { command: ["prepare"] } },
        { id: "install", phase: "app", command: { command: ["install"] } },
      ],
    });

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const orchestrator = yield* BuildOrchestrator;
          const error = yield* Effect.flip(orchestrator.buildApp(plan));
          return { error, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then
    expect(result.error._tag).toBe("BuildPhaseFailedError");
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    const blocked = result.error.failures.find((failure) => failure.step.id === "web:app:install");
    expect(blocked).toBeDefined();
    expect(blocked?.exitCode).toBeUndefined();
    const blockedEvent = result.events.find(
      (event) => event._tag === "task.fail" && event.taskId === "web:app:install",
    );
    if (blockedEvent?._tag !== "task.fail") throw new TypeError("blocked step task event is missing");
    expect(blockedEvent.exitCode).toBeUndefined();
  });
});

test("propagates a secret-store failure from the provider stream unchanged", async () => {
  await withTempRoots(async () => {
    // Given a provider stream that cannot read its secret store.
    const secretStoreFailure = new SecretStoreUnavailableError({
      message: "The secret store is locked.",
      storeId: "test-store",
      reason: "locked",
      remediation: "Unlock the secret store and retry.",
    });
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.fail(secretStoreFailure),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(error).toBe(secretStoreFailure);
    expect(error._tag).toBe("SecretStoreUnavailableError");
  });
});
