import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect, Layer, Result } from "effect";
import { makeMcpAppGenerations } from "../../src/cli/commands/meta/mcp-app-generations";
import { CliInvocation } from "../../src/runtime/invocation-context";
import { makeLandoGenerationRuntime } from "../../src/runtime/layer";
import { fixtureRoot, writeFixtureApp } from "./app-fixture";

test("generation projection and retry retain captured environment redaction", async () => {
  const root = await fixtureRoot("generation-environment");
  const secret = "generation-private-value";
  const env = { SESSION_API_TOKEN: secret };
  try {
    const app = await writeFixtureApp(root, "captured", {
      commands: [],
      serviceType: "captured-type",
      lazyCommand: `fixture:${secret}`,
    });
    const runtime = Result.getOrThrow(
      makeLandoGenerationRuntime({
        cwd: app.root,
        bootstrap: "app",
        interaction: "non-interactive",
        plugins: { policy: "discovery" },
      }),
    );
    const diagnostics = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* Layer.build(runtime.host);
          const apps = yield* makeMcpAppGenerations({ runtime, host, sessionIds: new Set() });
          env.SESSION_API_TOKEN = "changed-after-construction";
          const first = yield* withAppDiscovery(app.root, apps.acquire(app.root));
          const repeated = yield* withAppDiscovery(app.root, apps.acquire(app.root));
          return [first.diagnostics, repeated.diagnostics];
        }),
      ).pipe(
        Effect.provideService(CliInvocation, {
          cwd: app.root,
          env,
          io: createBufferedRendererIO(),
          setExitCode: () => undefined,
        }),
      ),
    );
    for (const records of diagnostics) {
      expect(records).toHaveLength(1);
      expect(records[0]?._tag).toBe("PluginLoadError");
      expect(records[0]?.message).toContain("[redacted]");
      expect(records[0]?.remediation).toContain("[redacted]");
      expect(JSON.stringify(records)).not.toContain(secret);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
