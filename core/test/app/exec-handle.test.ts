import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { makeLandoRuntime, resolveApp } from "@lando/core";
import { ProviderId } from "@lando/core/schema";
import { Renderer, RuntimeProvider, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";

test("App handle exec passes provider stderr through the captured library Renderer", async () => {
  // Given
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-exec-handle-")));
  await writeFile(
    join(dir, ".lando.yml"),
    `name: exec-handle\nruntime: 4\nprovider: ${TestRuntimeProvider.id}\nservices:\n  web:\n    type: node:lts\n    primary: true\n`,
  );
  const stderr: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    exec: () => Effect.succeed({ exitCode: 1, stdout: "", stderr: "library boom\n" }),
  };
  const runtime = Layer.merge(
    makeLandoRuntime({
      bootstrap: "app",
      cwd: dir,
      plugins: {
        policy: "bundled-only",
        layers: [
          Layer.succeed(RuntimeProvider, provider),
          Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([ProviderId.make(provider.id)]),
            capabilities: Effect.succeed(provider.capabilities),
            select: () => Effect.succeed(provider),
          }),
        ],
      },
    }),
    Layer.succeed(Renderer, {
      id: "exec-handle-test",
      capabilities: { color: false, interactive: false, animation: false, notifications: false },
      message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
      output: {
        stdout: () => Effect.void,
        stderr: (chunk) => Effect.sync(() => void stderr.push(chunk)),
      },
    }),
  );

  try {
    // When
    const result = await Effect.runPromise(
      resolveApp({ root: dir }).pipe(
        Effect.flatMap((app) => app.exec({ command: ["false"] })),
        Effect.scoped,
        Effect.provide(runtime),
      ),
    );

    // Then
    expect(result.stderr).toBe("library boom\n");
    expect(stderr).toEqual(["library boom\n"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
