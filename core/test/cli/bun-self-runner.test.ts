import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit, Layer, Queue, Stream } from "effect";

import { EventService } from "@lando/core/services";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { FileIoError } from "@lando/sdk/errors";
import { createRedactor } from "@lando/sdk/secrets";
import type { EventServiceShape, LandoEvent } from "@lando/sdk/services";
import { type BunSelfSpawner, bunSelfRun } from "../../src/cli/commands/bun-self-runner.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

test("caller overrides preserve Bun mode, the reentry guard, and credentials", async () => {
  // Given
  let childEnv: Readonly<Record<string, string>> = {};
  // When
  await Effect.runPromise(
    bunSelfRun({
      argv: ["--version"],
      env: { BUN_BE_BUN: "0", LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "0", NPM_TOKEN: "x" },
      spawner: {
        spawn: async ({ env }) => {
          childEnv = env;
          return { exitCode: 0 };
        },
      },
    }),
  );
  // Then
  expect(childEnv.BUN_BE_BUN).toBe("1");
  expect(childEnv.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBe("1");
  expect(childEnv.NPM_TOKEN).toBe("x");
});

test.skipIf(process.platform === "win32")("interruption keeps the launcher until spawn settles", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-interruption-"));
  const started = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<{ readonly exitCode: number }>();
  const controller = new AbortController();
  let launcherPath = "";
  let childSignal: AbortSignal | undefined;
  try {
    await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const running = Effect.runPromiseExit(
      bunSelfRun({
        argv: ["run", "v"],
        env: { PATH: root },
        spawner: {
          spawn: ({ env, signal }) => {
            childSignal = signal;
            launcherPath = Bun.which("lando", { PATH: env.PATH ?? "" }) ?? "";
            signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
            started.resolve();
            return settled.promise;
          },
        },
      }),
      { signal: controller.signal },
    );
    await started.promise;
    expect(childSignal).toBeInstanceOf(AbortSignal);
    // When
    controller.abort();
    await aborted.promise;
    // Then: the live child still has its launcher, and cleanup waits for its exit.
    expect(childSignal?.aborted).toBe(true);
    await access(dirname(launcherPath));
    settled.resolve({ exitCode: 0 });
    const exit = await running;
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    await expect(access(dirname(launcherPath))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    settled.resolve({ exitCode: 0 });
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("launcher preparation fails with FileIoError", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-preparation-"));
  try {
    await writeFile(join(root, "lando"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await withEnvVar("TMPDIR", join(root, "missing"), async () => {
      // When: flip turns only typed failures into successful values, leaving defects as failures.
      const failure = await Effect.runPromise(
        Effect.flip(
          bunSelfRun({
            argv: ["--version"],
            env: { PATH: root },
            spawner: { spawn: async () => ({ exitCode: 0 }) },
          }),
        ),
      );
      // Then
      expect(failure).toBeInstanceOf(FileIoError);
      expect(failure).toMatchObject({ path: tmpdir(), cause: { code: "ENOENT" } });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32").each([0, 7])(
  "package child lando uses its launcher and cleans up after exit %i",
  async (exitCode) => {
    // Given: the child's PATH selects a Lando delegate and Bun's markers must remain for other commands.
    const root = await mkdtemp(join(tmpdir(), "lando-package-env-"));
    let launcherPath = "";
    try {
      await writeFile(
        join(root, "lando"),
        '#!/bin/sh\nprintf "%s|%s|%s|%s" "${BUN_BE_BUN-unset}" "${BUN_FEATURE_FLAG_NO_ORPHANS-unset}" "$LANDO_DISALLOW_BUN_BE_BUN_REENTRY" "$1"\n',
        { mode: 0o700 },
      );
      // When
      const result = await Effect.runPromise(
        bunSelfRun({
          argv: ["run", "v"],
          cwd: root,
          env: { PATH: root, BUN_FEATURE_FLAG_NO_ORPHANS: "1" },
          spawner: {
            spawn: async ({ env, cmd }) => {
              expect(cmd).toEqual([process.execPath, "run", "v"]);
              expect(env.BUN_BE_BUN).toBe("1");
              expect(env.LANDO_DISALLOW_BUN_BE_BUN_REENTRY).toBe("1");
              launcherPath = Bun.which("lando", { PATH: env.PATH ?? "", cwd: root }) ?? "";
              const child = Bun.spawn([launcherPath, "version"], { env, stdout: "pipe", stderr: "pipe" });
              expect(await new Response(child.stdout).text()).toBe("unset|unset|1|version");
              expect(await child.exited).toBe(0);
              return { exitCode };
            },
          },
        }),
      );
      // Then
      expect(result.exitCode).toBe(exitCode);
      expect(dirname(launcherPath)).not.toBe(root);
      await expect(access(dirname(launcherPath))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const redactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    registerValues: registerRedactionValues,
    forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["topsecret"] })),
  }),
);

describe("bunSelfRun redaction", () => {
  test("redacts free-text pre/post bun-self-exec event fields without changing event shape", async () => {
    const events: Array<Record<string, unknown>> = [];
    const eventLayer = Layer.succeed(
      EventService,
      EventService.of({
        publish: (event: LandoEvent) => Effect.sync(() => events.push({ ...event })),
        subscribe: () => Stream.empty,
        subscribeQueue: Queue.unbounded<never>(),
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      } satisfies EventServiceShape),
    );
    const spawner: BunSelfSpawner = {
      spawn: async () => ({ exitCode: 0 }),
    };

    await Effect.runPromise(
      bunSelfRun({
        argv: ["install", "--registry=https://topsecret.example"],
        cwd: "/tmp/topsecret-project",
        env: { BUN_AUTH_TOKEN: "topsecret" },
        spawner,
        execPath: "/bin/bun",
        callerSubsystem: "plugin-topsecret",
        verb: "install-topsecret",
      }).pipe(Effect.provide(Layer.mergeAll(eventLayer, redactionLayer))),
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event._tag)).toEqual(["pre-bun-self-exec", "post-bun-self-exec"]);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        event._tag === "pre-bun-self-exec"
          ? ["_tag", "argv", "callerSubsystem", "cwd", "mode", "timestamp", "verb"]
          : ["_tag", "argv", "callerSubsystem", "cwd", "exitCode", "mode", "timestamp", "verb"],
      );
      expect(JSON.stringify(event)).not.toContain("topsecret");
      expect(JSON.stringify(event)).toContain("[redacted]");
      expect(event.mode).toBe("embedded");
    }
  });
});
