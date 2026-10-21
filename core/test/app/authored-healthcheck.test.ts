import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoRuntime } from "@lando/core";
import { startApp } from "@lando/core/cli/operations";
import { ProviderId } from "@lando/core/schema";
import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { Effect, Layer, Result } from "effect";
import { withCwd } from "../_support/temp-cwd.ts";

for (const kind of ["http", "tcp"] as const) {
  test(`real ${kind} start fails with the authored source before any provider action`, async () => {
    const root = await mkdtemp(join(tmpdir(), "authored-healthcheck-"));
    await writeFile(
      join(root, ".lando.yml"),
      "name: authored-healthcheck\nprovider: test\nservices:\n  web:\n    type: node:lts\n",
    );
    const local = join(root, ".lando.local.yml");
    await writeFile(local, `services:\n  web:\n    healthcheck:\n      kind: ${kind}\n`);
    const actions = { apply: 0, start: 0, build: 0, pull: 0, exec: 0 };
    const provider = {
      ...TestRuntimeProvider,
      apply: (...args: Parameters<typeof TestRuntimeProvider.apply>) =>
        TestRuntimeProvider.apply(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              actions.apply++;
            }),
          ),
        ),
      start: (...args: Parameters<typeof TestRuntimeProvider.start>) =>
        TestRuntimeProvider.start(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              actions.start++;
            }),
          ),
        ),
      buildArtifact: (...args: Parameters<typeof TestRuntimeProvider.buildArtifact>) =>
        TestRuntimeProvider.buildArtifact(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              actions.build++;
            }),
          ),
        ),
      pullArtifact: (...args: Parameters<typeof TestRuntimeProvider.pullArtifact>) =>
        TestRuntimeProvider.pullArtifact(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              actions.pull++;
            }),
          ),
        ),
      exec: (...args: Parameters<typeof TestRuntimeProvider.exec>) =>
        TestRuntimeProvider.exec(...args).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              actions.exec++;
            }),
          ),
        ),
    };
    try {
      const result = await withCwd(root, () =>
        Effect.runPromise(
          startApp({}).pipe(
            Effect.result,
            Effect.scoped,
            Effect.provide(
              makeLandoRuntime({
                bootstrap: "app",
                cwd: root,
                plugins: {
                  policy: "bundled-only",
                  layers: [
                    Layer.succeed(
                      RuntimeProviderRegistry,
                      RuntimeProviderRegistry.of({
                        list: Effect.succeed([ProviderId.make("test")]),
                        capabilities: Effect.succeed(provider.capabilities),
                        select: () => Effect.succeed(provider),
                      }),
                    ),
                  ],
                },
              }),
            ),
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "LandofileValidationError",
          file: local,
          issues: [
            {
              path: ["services", "web", "healthcheck", "kind"],
              source: { file: local, layer: "local", path: ["services", "web", "healthcheck", "kind"] },
            },
          ],
        });
      }
      expect(actions).toEqual({ apply: 0, start: 0, build: 0, pull: 0, exec: 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
