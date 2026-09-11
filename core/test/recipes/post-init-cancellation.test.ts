import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunnerLive } from "@lando/engine/services/process-runner";
import { plugin } from "@lando/lando4";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Exit, Stream } from "effect";
import { initApp } from "../../src/cli/commands/init";
import { RecipeInitPostInitError } from "../../src/recipes/init-pipeline";
import { runBoundPostInit } from "../../src/recipes/init-pipeline/post-init";
import * as postInitRuntime from "../../src/recipes/post-init/runtime";
import { createDefaultChoicesCommandRunner } from "../../src/recipes/prompts/choices-command";
import { defaultChoicesCommandSpawner } from "../../src/recipes/prompts/choices-command";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe";

test("initApp cancellation kills and reaps its post-init child", async () => {
  // Given a real init pipeline whose post-init action runs a harmless child
  const root = await mkdtemp(join(tmpdir(), "lando-init-abort-"));
  const controller = new AbortController();
  const ready = Promise.withResolvers<number>();
  const finished = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      ready.resolve(Number(await request.text()));
      return new Response("ready");
    },
  });
  const action = spyOn(postInitRuntime, "runPostInit").mockImplementation(async (bound) => {
    if (bound.spawner === undefined) throw new Error("Missing bound spawner");
    try {
      await bound.spawner.spawn({
        cmd: [
          process.execPath,
          "-e",
          `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 5000); await fetch(${JSON.stringify(server.url.href)}, {method:"POST",body:String(process.pid)});`,
        ],
        cwd: bound.destination,
        env: {},
      });
      return { executed: [] };
    } finally {
      finished.resolve();
    }
  });
  let pid: number | undefined;
  const options = {
    cwd: root,
    destination: join(root, "app"),
    userDataRoot: join(root, "data"),
    recipe: "empty",
    name: "test",
    full: false,
    nonInteractive: true,
    signal: controller.signal,
    privateFileAccess: ownerOnlyFileAccess,
  };
  const completion = initApp(options).then(
    () => "success",
    () => "failure",
  );
  try {
    pid = await Effect.runPromise(Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")));
    // When the caller aborts init rather than its internal post-init wrapper
    controller.abort();
    // Then init fails promptly and the real child is killed and reaped
    expect(await Effect.runPromise(Effect.promise(() => completion).pipe(Effect.timeout("500 millis")))).toBe(
      "failure",
    );
    await Effect.runPromise(Effect.promise(() => finished.promise).pipe(Effect.timeout("500 millis")));
    expect(() => process.kill(pid ?? 0, 0)).toThrow();
  } finally {
    controller.abort();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (cause) {
        expect(cause).toMatchObject({ code: "ESRCH" });
      }
    }
    await completion;
    action.mockRestore();
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

test("cancellation through post-init kills and reaps the live runner child", async () => {
  const ready = Promise.withResolvers<number>();
  const childFinished = Promise.withResolvers<void>();
  const controller = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      ready.resolve(Number(await request.text()));
      return new Response("ready");
    },
  });
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing translator fixture");
  const program = runBoundPostInit({
    request: {
      appRoot: process.cwd(),
      privateFileAccess: ownerOnlyFileAccess,
      journalRoot: () => process.cwd(),
      appName: "test",
      answers: {},
      manifest: { ...isolatedInitManifest, postInit: [{ type: "bun", verb: "install" }] },
      decomposer: isolatedInitDecomposer,
      encoder: await loader(),
      runPostInit: async (bound) => {
        if (bound.spawner === undefined) throw new Error("Missing real process adapter");
        try {
          await bound.spawner.spawn({
            cmd: [
              process.execPath,
              "-e",
              `process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 5000); await fetch(${JSON.stringify(server.url.href)}, {method:"POST",body:String(process.pid)});`,
            ],
            cwd: bound.destination,
            env: {},
          });
          return { executed: [] };
        } finally {
          childFinished.resolve();
        }
      },
    },
    redact: (value) => value,
    postFailure: (failedAction) =>
      new RecipeInitPostInitError({
        message: "Failed",
        remediation: "Retry",
        committedLandofile: "/unused",
        committedAuxiliaryFiles: [],
        failedAction,
        rolledBack: false,
      }),
  }).pipe(Effect.provide(ProcessRunnerLive));
  const completion = Effect.runPromiseExit(program, { signal: controller.signal });
  let pid: number | undefined;
  try {
    const childPid = await Effect.runPromise(
      Effect.promise(() => ready.promise).pipe(Effect.timeout("2 seconds")),
    );
    pid = childPid;
    controller.abort();
    const exit = await Effect.runPromise(Effect.promise(() => completion).pipe(Effect.timeout("500 millis")));
    expect(Exit.isFailure(exit)).toBe(true);
    await Effect.runPromise(Effect.promise(() => childFinished.promise).pipe(Effect.timeout("500 millis")));
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    controller.abort();
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (cause) {
        expect(cause).toMatchObject({ code: "ESRCH" });
      }
    }
    await server.stop(true);
  }
}, 4000);

test("interrupts the nested runner when post-init is cancelled", async () => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const controller = new AbortController();
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing translator fixture");
  const program = runBoundPostInit({
    request: {
      appRoot: process.cwd(),
      privateFileAccess: ownerOnlyFileAccess,
      journalRoot: () => process.cwd(),
      manifest: { ...isolatedInitManifest, postInit: [{ type: "command", cmd: "app:config:translate" }] },
      appName: "test",
      answers: {},
      decomposer: isolatedInitDecomposer,
      encoder: await loader(),
    },
    redact: (value) => value,
    postFailure: (failedAction) =>
      new RecipeInitPostInitError({
        message: "Failed",
        remediation: "Retry",
        committedLandofile: "/unused",
        committedAuxiliaryFiles: [],
        failedAction,
        rolledBack: false,
      }),
  }).pipe(
    Effect.provideService(ProcessRunner, {
      run: () =>
        Effect.acquireUseRelease(
          Effect.sync(() => started.resolve()),
          () => Effect.never.pipe(Effect.timeout("2 seconds"), Effect.orDie),
          () => Effect.sync(() => released.resolve()),
        ),
      stream: () => Stream.empty,
    }),
  );
  const result = Effect.runPromiseExit(program, { signal: controller.signal });
  try {
    await started.promise;
    controller.abort();
    await result;
    await Effect.runPromise(Effect.promise(() => released.promise).pipe(Effect.timeout("500 millis")));
  } finally {
    controller.abort();
    await released.promise;
  }
}, 4000);

test("rejects a pre-aborted command before spawning", async () => {
  const signal = AbortSignal.abort();
  await expect(
    defaultChoicesCommandSpawner.spawn({
      cmd: ["/nonexistent-cancellation-fixture"],
      cwd: process.cwd(),
      signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("aborts the default child runner without waiting for natural exit", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      started.resolve();
      return new Response("ready");
    },
  });
  const runner = createDefaultChoicesCommandRunner({
    execPath: process.execPath,
    argv: [process.execPath],
    standalone: true,
    cwd: process.cwd(),
  });
  const input = {
    command: "-e",
    args: [
      `setTimeout(() => process.exit(0), 2000); process.on("SIGTERM", () => {}); await fetch(${JSON.stringify(server.url.href)});`,
    ],
    signal: controller.signal,
  };
  const outcome = runner(input);
  try {
    await started.promise;
    controller.abort();
    const aborted = outcome.then(
      () => false,
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );
    expect(await Effect.runPromise(Effect.promise(() => aborted).pipe(Effect.timeout("500 millis")))).toBe(
      true,
    );
  } finally {
    controller.abort();
    await outcome.catch(() => undefined);
    await server.stop(true);
  }
}, 4000);
