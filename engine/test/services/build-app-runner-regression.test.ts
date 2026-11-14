import { expect, test } from "bun:test";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderInternalError, SecretStoreUnavailableError } from "@lando/sdk/errors";
import { LOG_LINE_TRUNCATED_MARKER } from "@lando/sdk/log-follow";
import { AbsolutePath, AppId, ServiceName } from "@lando/sdk/schema";
import type { ExecTarget, RuntimeProviderShape } from "@lando/sdk/services";
import { BuildOrchestrator, EventService, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Fiber, Queue, Stream } from "effect";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { appSteps } from "../../src/services/build-app-plan.ts";
import {
  openAppBuildResults,
  openScratchBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
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
    });
    const stepFailure = result.error.failures[0];
    expect(stepFailure?.remediation).toEndWith('Run "lando logs --build --service node" to print it.');
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

test("caps the published task detail line while the transcript keeps the framed line", async () => {
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
    expect(detailLine.length).toBe(512 + LOG_LINE_TRUNCATED_MARKER.length);
    expect(detailLine).toEndWith(LOG_LINE_TRUNCATED_MARKER);
    const start = result.find((event) => event._tag === "task.start");
    if (start?._tag !== "task.start") throw new TypeError("task start event is missing");
    expect(await readFile(String(start.transcriptPath), "utf8")).toBe(
      `${output.slice(0, 65_536)}${LOG_LINE_TRUNCATED_MARKER}\n`,
    );
  });
});

test("sweeps unreferenced app transcripts after a successful phase", async () => {
  await withTempRoots(async () => {
    // Given an app phase directory left with a stale file and an orphaned service directory.
    const phase = join(process.env.LANDO_USER_DATA_ROOT ?? "", "builds", "app-build-runner", "app");
    await mkdir(join(phase, "web"), { recursive: true });
    await mkdir(join(phase, "ghost"), { recursive: true });
    await writeFile(join(phase, "web", "stale.log"), "stale\n");
    await writeFile(join(phase, "ghost", "stale.log"), "stale\n");
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 0 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then the step transcript stays and everything else goes.
    expect(await Bun.file(join(phase, "web", "stale.log")).exists()).toBe(false);
    const webFiles = await readdir(join(phase, "web"));
    expect(webFiles).toHaveLength(1);
    expect(webFiles[0]).toEndWith(".log");
    await expect(access(join(phase, "ghost"))).rejects.toThrow();
  });
});

test("keeps unreferenced app transcripts when the phase fails", async () => {
  await withTempRoots(async () => {
    // Given a stale transcript and a step that exits nonzero.
    const phase = join(process.env.LANDO_USER_DATA_ROOT ?? "", "builds", "app-build-runner", "app");
    await mkdir(join(phase, "web"), { recursive: true });
    const stale = join(phase, "web", "stale.log");
    await writeFile(stale, "stale\n");
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 7 }),
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });

    // When
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await Bun.file(stale).exists()).toBe(true);
  });
});

test("reusing an older app-step key moves it to the newest position", async () => {
  await withTempRoots(async () => {
    // Given an older recorded key for the step this plan runs, and a newer key of the same step.
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      inspect: (target) =>
        Effect.succeed({
          app: target.app,
          service: target.service,
          providerId,
          publications: { status: "unknown" },
          status: "running",
          containerId: "web-1",
        }),
      execStream: () => {
        calls.push("dispatch");
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const plan = planWith({
      web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
    });
    const stepKey = appSteps(plan)[0]?.step.buildKey;
    if (stepKey === undefined) throw new TypeError("step is missing");
    const directory = join(process.env.LANDO_USER_DATA_ROOT ?? "", "builds", String(plan.id), "app", "web");
    const olderPath = join(directory, `${stepKey}.log`);
    const newerPath = join(directory, "newer.log");
    await mkdir(directory, { recursive: true });
    await writeFile(olderPath, "version 6\n");
    await writeFile(newerPath, "version 7\n");

    // When
    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const stateStore = yield* StateStore;
        const bucket = yield* openAppBuildResults(stateStore, String(plan.id));
        yield* recordBuildResult(bucket, {
          buildKey: stepKey,
          containerId: "web-1",
          service: ServiceName.make("web"),
          phase: "app",
          step: "web:app:install",
          outcome: "complete",
          exitCode: 0,
          durationMs: 1,
          transcriptPath: AbsolutePath.make(olderPath),
        });
        yield* recordBuildResult(bucket, {
          buildKey: "newer-key",
          containerId: "web-1",
          service: ServiceName.make("web"),
          phase: "app",
          step: "web:app:install",
          outcome: "complete",
          exitCode: 0,
          durationMs: 1,
          transcriptPath: AbsolutePath.make(newerPath),
        });
        yield* (yield* BuildOrchestrator).buildApp(plan);
        return (yield* bucket.get) ?? [];
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then the reused step never dispatched and its entry is last.
    expect(calls).toEqual([]);
    expect(entries.map((entry) => entry.buildKey)).toEqual(["newer-key", stepKey]);
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
    expect(stepFailure?.remediation).toEndWith('Run "lando logs --build --service web" to print it.');
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

test("names no transcript path in a failed scratch app step remediation", async () => {
  await withTempRoots(async () => {
    // Given a scratch plan with one app step that exits nonzero.
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 7 }),
    } satisfies RuntimeProviderShape;
    const plan = {
      ...planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      }),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "app-build-runner" } },
    };

    // When
    const error = await Effect.runPromise(
      Effect.flip(Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan))).pipe(
        Effect.provide(makeLayer(provider)),
      ),
    );

    // Then the whole remediation stays pathless: failure cleanup deletes that transcript.
    expect(error._tag).toBe("BuildPhaseFailedError");
    if (error._tag !== "BuildPhaseFailedError") throw error;
    const failure = error.failures[0];
    expect(failure?.remediation).toBe(
      "Fix step web:app:install, and rebuild. The scratch app and its build output are removed after a failed start unless it is kept; keep it with lando scratch:start --keep-on-failure.",
    );
    expect(failure?.remediation).not.toContain(String(failure?.transcriptPath));
    expect(failure?.remediation).not.toContain("/builds/");
  });
});

test("treats a user app named scratch-* as a user app", async () => {
  await withTempRoots(async () => {
    // Given a user plan whose id starts with the scratch prefix but carries no scratch extension.
    const provider = {
      ...TestRuntimeProvider,
      execStream: () => Stream.make({ exitCode: 7 }),
    } satisfies RuntimeProviderShape;
    const plan = {
      ...planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      }),
      id: AppId.make("scratch-demo"),
      slug: "scratch-demo",
    };

    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stateStore = yield* StateStore;
          const error = yield* Effect.flip(
            Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.buildApp(plan)),
          );
          const appBucket = yield* openAppBuildResults(stateStore, "scratch-demo");
          const scratchBucket = yield* openScratchBuildResults(stateStore);
          return {
            error,
            appEntries: (yield* appBucket.get) ?? [],
            scratchEntries: (yield* scratchBucket.get) ?? [],
          };
        }),
      ).pipe(Effect.provide(makeLayer(provider))),
    );

    // Then the per-app index, the non-scratch directory, and the user remediation all apply.
    expect(result.error._tag).toBe("BuildPhaseFailedError");
    if (result.error._tag !== "BuildPhaseFailedError") throw result.error;
    const failure = result.error.failures[0];
    expect(String(failure?.transcriptPath)).toContain(join("builds", "scratch-demo", "app", "web"));
    expect(String(failure?.transcriptPath)).not.toContain(join("builds", "scratch", "scratch-demo"));
    expect(result.appEntries).toHaveLength(1);
    expect(result.scratchEntries).toEqual([]);
    expect(failure?.remediation).toContain(
      `Inspect the build transcript at ${String(failure?.transcriptPath)}, fix step web:app:install, and rebuild.`,
    );
    expect(failure?.remediation).toEndWith('Run "lando logs --build --service web" to print it.');
  });
});
