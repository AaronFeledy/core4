import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, DateTime, Effect, Layer } from "effect";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor";
import { environmentResolverLayer } from "../_support/value-contracts";

test("event script maps preserve sparse identity and false without requiring a planner or provider", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-event-script-input-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/inspect.bun.sh"),
      '# ---\n# flags:\n#   loud:\n#     boolean: true\n#     default: true\n# args:\n#   first:\n#   second:\n# ---\necho "$LANDO_INPUT"\n',
    );
    const plan: AppPlan = {
      id: AppId.make("event-script"),
      name: "event-script",
      slug: "event-script",
      root: AbsolutePath.make(root),
      provider: ProviderId.make("test"),
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { resolvedAt: DateTime.makeUnsafe(0), source: join(root, ".lando.yml"), runtime: 4 },
    };
    const layer = Layer.mergeAll(
      PrivateFileAccessService.layer,
      environmentResolverLayer(),
      Layer.succeed(
        Renderer,
        Renderer.of({
          id: "silent",
          capabilities: RENDERER_CAPABILITIES_NONE,
          message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
          output: { stdout: () => Effect.void, stderr: () => Effect.void },
        }),
      ),
    );
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Layer.build(layer);
          return yield* makeEventCommandExecutor(Context.makeUnsafe<unknown>(runtime.mapUnsafe)).run({
            command: "app:inspect",
            flags: { loud: false },
            args: { second: "later" },
            argv: [],
            cwd: root,
            plan,
          });
        }),
      ),
    );
    // Then
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ flags: { loud: false }, args: { second: "later" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
