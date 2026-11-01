import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManifest } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { globalPolicyBucket } from "../../src/global-app/enablement.ts";
import { GlobalListResultSchema, globalList } from "../../src/operations/global-list.ts";
import { makeGlobalLifecycleFixture } from "../../src/testing/global-lifecycle.ts";

test("lists disabled contributions without evaluating modules or materializing runtime state", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-list-"));
  try {
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/global",
      version: "1.0.0",
      api: 4,
      contributes: {
        globalServices: [{ id: "mail", module: "/missing/must-not-load.ts", enabledByDefault: false }],
      },
    });
    const fixture = makeGlobalLifecycleFixture(root, [manifest]);
    const result = await Effect.runPromise(globalList().pipe(Effect.provide(fixture.layer)));
    expect(Schema.is(GlobalListResultSchema)(result)).toBe(true);
    expect(result.services).toMatchObject([
      { id: "mail", state: "disabled", enabled: false, plugin: "@example/global" },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(fixture.planned).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lists retained policy for unavailable plugins without inventing runtime services", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-list-retained-"));
  try {
    const fixture = makeGlobalLifecycleFixture(root);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* globalPolicyBucket();
        yield* bucket.set({
          revision: 4,
          plugins: {
            "@example/removed": {
              enabled: false,
              contributions: { mail: { enabled: true, defaultEnabled: false } },
            },
          },
        });
        return yield* globalList();
      }).pipe(Effect.provide(fixture.layer)),
    );
    expect(result.revision).toBe(4);
    expect(result.services).toEqual([]);
    expect(result.retainedPolicies).toEqual([
      {
        plugin: "@example/removed",
        enabled: false,
        contributions: [{ id: "mail", enabled: true, defaultEnabled: false }],
      },
    ]);
    expect(fixture.planned).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
