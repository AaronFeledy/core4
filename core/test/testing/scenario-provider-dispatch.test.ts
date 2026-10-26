import { expect, test } from "bun:test";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { withScenarioContext } from "@lando/core/testing";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";

const planAt = (id: string, appRoot: AbsolutePath): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root: appRoot,
  identity: { appRoot, ownerKey: `${id}-owner` },
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
    source: "scenario-provider-dispatch.test",
    runtime: 4,
  },
  extensions: {},
});

test("uses the test runtime provider for exec when a guide uses the scenario harness", async () => {
  const result = await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "test-provider-exec" }, (context) =>
      Effect.gen(function* () {
        // Given: a provider:test guide fixture whose lifecycle start is handled by the scenario harness.
        yield* context.fixtures.use("exec-demo");
        yield* context.runCli(["start"]);

        // When: the same guide invokes the real app:exec CLI path.
        return yield* context.runCli(["exec", "--", "echo", "hello"]);
      }),
    ),
  );

  // Then: exec is dispatched through TestRuntimeProvider rather than a live provider registry.
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("echo hello\n");
  expect(result.stderr).toBe("");
});

test("observes the scenario's applied plan after its desired Landofile becomes invalid", async () => {
  const result = await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "applied-info" }, (context) =>
      Effect.gen(function* () {
        // Given: a started app whose desired configuration no longer parses.
        const root = yield* context.fixtures.use("exec-demo");
        const started = yield* context.runCli(["start"]);
        expect(started.exitCode).toBe(0);
        yield* Effect.tryPromise(() => Bun.write(join(root, ".lando.yml"), "services: [invalid\n"));

        // When: info observes the app through the real CLI dispatcher.
        return yield* context.runCli(["info", "--format=json"]);
      }),
    ),
  );

  // Then: the applied app remains observable without planning the invalid desired state.
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { app: "exec-demo" } });
});

test("resolves the applied plan when later commands use a symlink alias of the root", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "alias-applied-plan" }, (context) =>
      Effect.gen(function* () {
        // Given: applied state stored under the planner's canonical root.
        const root = yield* context.fixtures.use("exec-demo");
        const alias = join(context.testDir, "linked-app");
        yield* Effect.tryPromise(() => symlink(root, alias, "dir"));
        const provider = makeScenarioProvider();
        yield* Effect.tryPromise(() => provider.remember(root));

        // When: a later command resolves applied state through the alias path.
        const planned = yield* Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          return yield* registry.resolveAppliedPlan(AbsolutePath.make(alias));
        }).pipe(Effect.provide(provider.layer));

        // Then: the alias still finds the realization, the way production ancestor matching does.
        expect(planned?.root).toBeDefined();
        expect(planned?.id).toBe(AppId.make("exec-demo"));
      }),
    ),
  );
});

test("prefers the longest matching applied plan the way production ancestor matching does", async () => {
  const provider = makeScenarioProvider();
  const parent = planAt("parent-app", AbsolutePath.make("/tmp/scenario-parent"));
  const child = planAt("child-app", AbsolutePath.make("/tmp/scenario-parent/child"));
  await Effect.runPromise(Effect.scoped(provider.provider.apply(parent, { reconcile: false })));
  await Effect.runPromise(Effect.scoped(provider.provider.apply(child, { reconcile: false })));

  const planned = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      return yield* registry.resolveAppliedPlan(AbsolutePath.make("/tmp/scenario-parent/child/nested"));
    }).pipe(Effect.provide(provider.layer)),
  );

  expect(planned?.id).toBe(AppId.make("child-app"));
});

test("forgets the applied plan when destroy uses a symlink to its root", async () => {
  await Effect.runPromise(
    withScenarioContext({ guideId: "exec", scenarioId: "symlink-destroy" }, (context) =>
      Effect.gen(function* () {
        // Given: applied state stored under a canonical root and an alias to that root.
        const root = yield* context.fixtures.use("exec-demo");
        const alias = join(context.testDir, "linked-app");
        yield* Effect.tryPromise(() => symlink(root, alias, "dir"));
        const provider = makeScenarioProvider();
        yield* Effect.tryPromise(() => provider.remember(root));

        // When: destroy removes applied state through the alias.
        yield* Effect.tryPromise(() => provider.forget(alias));

        // Then: both observation and teardown agree that the realization is absent.
        const evidence = yield* Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          return yield* Effect.all({
            applied: registry.resolveAppliedPlan(AbsolutePath.make(root)),
            teardown: registry.resolveTeardownEvidence(AbsolutePath.make(root)),
            placement: registry.appliedPlansFor(AbsolutePath.make(root)),
          });
        }).pipe(Effect.provide(provider.layer));
        expect(evidence).toEqual({ applied: undefined, teardown: { kind: "absent" }, placement: [] });
      }),
    ),
  );
});
