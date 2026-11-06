import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, PluginManifest, ProviderId, appIdentityKey } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Cause, Effect, Exit, Schema } from "effect";
import { readGlobalPolicy } from "../../src/global-app/enablement.ts";
import { GlobalPolicyReconciliationError } from "../../src/global-app/errors.ts";
import { readGlobalReconciliation } from "../../src/global-app/reconciliation.ts";
import { globalDisable, globalReconcile } from "../../src/operations/global-policy.ts";
import { makeGlobalLifecycleFixture } from "../../src/testing/global-lifecycle.ts";

const withFixture = async (use: (f: ReturnType<typeof makeGlobalLifecycleFixture>) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "lando-policy-cleanup-"));
  try {
    const module = join(directory, "global.ts");
    await writeFile(
      module,
      'import { Effect } from "effect"; export default Effect.succeed({ type: "compose", image: "fixture:v1" });\n',
    );
    const manifest = Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/global",
      version: "1.0.0",
      api: 4,
      contributes: { globalServices: ["mail", "sibling"].map((id) => ({ id, module })) },
    });
    const f = makeGlobalLifecycleFixture(directory, [manifest]);
    await mkdir(f.root);
    const plan = f.planFor(["mail", "sibling"]);
    f.setApplied(plan);
    f.startContainer(plan, "sibling");
    await use(f);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("disable withdraws confirmed-missing planned service routes without claiming removal", async () => {
  await withFixture(async (f) => {
    const result = await Effect.runPromise(
      globalDisable({ selectors: ["mail"] }).pipe(Effect.provide(f.layer)),
    );
    expect(result.pending).toEqual([]);
    expect(result.servicesRemoved).toEqual([]);
    expect(f.removed).toEqual([]);
    expect(f.published).toEqual([["sibling"]]);
    expect(f.inventory().find((row) => row.service === "mail")?.mounts?.status).toBe("missing");
  });
});

test.each([
  { publications: { status: "unknown" as const } },
  { mounts: { status: "unknown" as const } },
  { status: "running" as const },
  { status: "exited" as const },
  { status: "unknown" as const },
  { providerId: ProviderId.make("other") },
])("missing container id with incomplete evidence stays pending: %j", async (override) => {
  await withFixture(async (f) => {
    f.missingOverrides.set("mail", override);
    const result = await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"] })).pipe(Effect.provide(f.layer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(GlobalPolicyReconciliationError);
      if (result.failure instanceof GlobalPolicyReconciliationError)
        expect(result.failure.pending.map((entry) => entry.phase)).toEqual(["evidence"]);
    }
    expect(f.published).toEqual([]);
    expect(f.removed).toEqual([]);
  });
});

test("reconcile retries pending missing-container route cleanup and preserves sibling routes", async () => {
  await withFixture(async (f) => {
    f.setFailRoutes(true);
    await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"] })).pipe(Effect.provide(f.layer)),
    );
    const pending = await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(f.layer)));
    expect(pending.pending.map((entry) => entry.phase)).toEqual(["routes"]);
    f.setFailRoutes(false);
    const result = await Effect.runPromise(globalReconcile().pipe(Effect.provide(f.layer)));
    expect(result.pending).toEqual([]);
    expect(result.servicesRemoved).toEqual([]);
    expect(f.published).toEqual([["sibling"]]);
  });
});

test.each(["disable", "reconcile"] as const)(
  "%s converges after interruption immediately following every receipt write",
  async (operation) => {
    const attempt = async (interruptAt?: number) => {
      let writes = 0;
      await withFixture(async (f) => {
        f.startContainer(f.planFor(["mail", "sibling"]), "mail");
        if (operation === "reconcile") {
          f.setOnline(false);
          const seeded = await Effect.runPromise(
            Effect.result(globalDisable({ selectors: ["mail"], allowDisruption: true })).pipe(
              Effect.provide(f.layer),
            ),
          );
          expect(seeded._tag).toBe("Failure");
          if (seeded._tag === "Failure")
            expect(seeded.failure).toBeInstanceOf(GlobalPolicyReconciliationError);
          f.setOnline(true);
        }
        const afterWrite = Effect.suspend(() => {
          writes += 1;
          return writes === interruptAt ? Effect.interrupt : Effect.void;
        });
        const store = StateStore.of({
          ...f.state.service,
          open: (spec) =>
            f.state.service.open(spec).pipe(
              Effect.map((bucket) =>
                spec.key !== ".lando.reconciliation.json"
                  ? bucket
                  : {
                      ...bucket,
                      set: (value) => bucket.set(value).pipe(Effect.tap(afterWrite)),
                      update: (change) => bucket.update(change).pipe(Effect.tap(afterWrite)),
                      modify: (change) => bucket.modify(change).pipe(Effect.tap(afterWrite)),
                      mutate: (change) => bucket.mutate(change).pipe(Effect.tap(afterWrite)),
                    },
              ),
            ),
        });
        const exit = await Effect.runPromiseExit(
          (operation === "disable" ? globalDisable({ selectors: ["mail"] }) : globalReconcile()).pipe(
            Effect.provideService(StateStore, store),
            Effect.provide(f.layer),
          ),
        );
        if (interruptAt === undefined) {
          expect(Exit.isSuccess(exit)).toBe(true);
          return;
        }
        expect(writes).toBe(interruptAt);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        const resumed = await Effect.runPromise(globalReconcile().pipe(Effect.provide(f.layer)));
        expect(resumed.pending).toEqual([]);
        expect(
          (await Effect.runPromise(readGlobalReconciliation().pipe(Effect.provide(f.layer)))).pending,
        ).toEqual([]);
        expect(f.removed).toEqual(["mail"]);
        expect([...f.containers.keys()]).toEqual(["sibling"]);
        expect(f.published.at(-1)).toEqual(["sibling"]);
      });
      return writes;
    };
    const writes = await attempt();
    expect(writes).toBeGreaterThan(0);
    for (let interruptAt = 1; interruptAt <= writes; interruptAt += 1) await attempt(interruptAt);
  },
);

test("offline evidence refuses without acknowledgement and saves pending intent only when acknowledged", async () => {
  await withFixture(async (f) => {
    f.setOnline(false);
    const refusal = await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"] })).pipe(Effect.provide(f.layer)),
    );
    expect(refusal._tag).toBe("Failure");
    if (refusal._tag === "Failure") expect(refusal.failure._tag).toBe("GlobalConsumerProtectionError");
    expect((await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(f.layer)))).revision).toBe(0);
    const saved = await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"], allowDisruption: true })).pipe(
        Effect.provide(f.layer),
      ),
    );
    expect(saved._tag).toBe("Failure");
    if (saved._tag === "Failure" && saved.failure instanceof GlobalPolicyReconciliationError)
      expect(saved.failure.pending.map((entry) => entry.phase)).toEqual(["evidence"]);
    else throw new Error("Expected acknowledged saved intent with pending evidence");
    expect((await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(f.layer)))).revision).toBe(1);
    expect(f.published).toEqual([]);
  });
});

test("active consumer refusal leaves policy and containers unchanged", async () => {
  await withFixture(async (f) => {
    const root = AbsolutePath.make(join(f.root, "consumer"));
    const consumer = {
      ...f.planFor(["web"]),
      id: AppId.make("consumer"),
      root,
      identity: { appRoot: root, ownerKey: appIdentityKey("owner", root) },
      requires: { globalServices: ["mail"] },
    };
    f.setConsumers([consumer]);
    f.startContainer(consumer, "web");
    const result = await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"] })).pipe(Effect.provide(f.layer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && "consumers" in result.failure)
      expect(result.failure.consumers).toHaveLength(1);
    expect((await Effect.runPromise(readGlobalPolicy().pipe(Effect.provide(f.layer)))).revision).toBe(0);
    expect(f.removed).toEqual([]);
    expect(f.published).toEqual([]);
  });
});

test("unrelated generation failure does not prevent confirmed-missing cleanup", async () => {
  await withFixture(async (f) => {
    await writeFile(
      join(f.root, "..", "global.ts"),
      'import { Effect } from "effect"; export default Effect.fail("broken contribution");\n',
    );
    const result = await Effect.runPromise(
      Effect.result(globalDisable({ selectors: ["mail"] })).pipe(Effect.provide(f.layer)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure" && result.failure instanceof GlobalPolicyReconciliationError) {
      expect(result.failure.pending.map((entry) => entry.phase)).toEqual(["generation"]);
      expect(result.failure.servicesRemoved).toEqual([]);
    } else throw new Error("Expected saved generation failure");
    expect(f.published).toEqual([["sibling"]]);
  });
});
