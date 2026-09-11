import { expect, test } from "bun:test";
import { plugin } from "@lando/lando4";
import { ProcessRunner } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { RecipeInitPostInitError } from "../../src/recipes/init-pipeline";
import { runBoundPostInit } from "../../src/recipes/init-pipeline/post-init";
import { createDefaultChoicesCommandRunner } from "../../src/recipes/prompts/choices-command";
import { defaultChoicesCommandSpawner } from "../../src/recipes/prompts/choices-command";
import { isolatedInitDecomposer, isolatedInitManifest } from "./fixtures/isolated-init-recipe";

test("interrupts the nested runner when post-init is cancelled", async () => {
  const started = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const controller = new AbortController();
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing translator fixture");
  const program = runBoundPostInit({
    request: {
      appRoot: process.cwd(),
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
