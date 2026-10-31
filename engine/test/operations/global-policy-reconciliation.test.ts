import { expect, test } from "bun:test";
import { AbsolutePath, PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import { GlobalAppService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { GlobalPolicyReconciliationError } from "../../src/global-app/errors.ts";
import {
  readGlobalReconciliation,
  recordGlobalGeneration,
  recordGlobalReconciliation,
  recordGlobalResourceCleanup,
} from "../../src/global-app/reconciliation.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const fixture = () => {
  const store = makeTestStateStore();
  const app = (root: string) =>
    GlobalAppService.of({
      id: "global",
      root: Effect.succeed(AbsolutePath.make(root)),
      paths: Effect.succeed({
        root: AbsolutePath.make(root),
        distLandofile: AbsolutePath.make(`${root}/.lando.dist.yml`),
        userLandofile: AbsolutePath.make(`${root}/.lando.yml`),
      }),
      providerId: Effect.succeed(ProviderId.make("lando")),
      ensureRoot: Effect.void,
      ensureUserLandofile: Effect.die("Receipt reads cannot materialize configuration."),
      regenerateDist: () => Effect.die("Receipt reads cannot regenerate configuration."),
      ensureRunning: () => Effect.die("Receipt reads cannot start containers."),
    });
  const layer = (root = "/tmp/core4-global-policy-receipts/global") =>
    Layer.mergeAll(store.layer, Layer.succeed(GlobalAppService, app(root)));
  return {
    store,
    layer,
    run: <A, E>(body: Effect.Effect<A, E, GlobalAppService | import("@lando/sdk/services").StateStore>) =>
      Effect.runPromise(body.pipe(Effect.provide(layer()))),
  };
};

test("a new selection preserves unrelated pending cleanup across receipt reads", async () => {
  const f = fixture();
  await f.run(
    recordGlobalReconciliation({
      revision: 1,
      operation: "disable",
      contributions: ["mail"],
      servicesRemoved: ["mail"],
      pending: [
        { phase: "routes", services: ["mail"], message: "Route withdrawal failed." },
        { phase: "generation", services: ["mail"], message: "Generation failed." },
      ],
    }),
  );
  await f.run(
    recordGlobalReconciliation({
      revision: 2,
      operation: "disable",
      contributions: ["proxy"],
      servicesRemoved: [],
      pending: [{ phase: "containers", services: ["proxy"], message: "Provider is offline." }],
    }),
  );
  const saved = await f.run(readGlobalReconciliation());
  expect(saved.revision).toBe(2);
  expect(saved.pending).toEqual([
    { phase: "routes", services: ["mail"], message: "Route withdrawal failed." },
    { phase: "containers", services: ["proxy"], message: "Provider is offline." },
  ]);
  await f.run(
    recordGlobalReconciliation({
      revision: 3,
      operation: "enable",
      contributions: ["mail"],
      servicesRemoved: [],
      pending: [],
    }),
  );
  expect((await f.run(readGlobalReconciliation())).pending).toEqual([
    { phase: "containers", services: ["proxy"], message: "Provider is offline." },
  ]);
});

test("configuration repair does not erase container and route cleanup evidence", async () => {
  const f = fixture();
  await f.run(
    recordGlobalReconciliation({
      revision: 1,
      operation: "disable",
      contributions: ["mail"],
      servicesRemoved: ["mail"],
      pending: [
        { phase: "routes", services: ["mail"], message: "Retry route withdrawal." },
        { phase: "generation", services: ["mail"], message: "Retry generation." },
      ],
    }),
  );
  await f.run(recordGlobalGeneration(1));
  const repaired = await f.run(readGlobalReconciliation());
  expect(repaired.servicesRemoved).toEqual(["mail"]);
  expect(repaired.pending.map((entry) => entry.phase)).toEqual(["routes"]);
});

test("proven whole-app teardown completes resource cleanup while retaining generation work", async () => {
  const f = fixture();
  await f.run(
    recordGlobalReconciliation({
      revision: 4,
      operation: "reconcile",
      contributions: ["mail"],
      servicesRemoved: [],
      pending: [
        { phase: "evidence", services: ["mail"], message: "Applied metadata is missing." },
        { phase: "routes", services: ["mail"], message: "Routes cannot be verified." },
        { phase: "generation", services: [], message: "Generation still needs repair." },
      ],
    }),
  );
  await f.run(recordGlobalResourceCleanup());
  expect((await f.run(readGlobalReconciliation())).pending).toEqual([
    { phase: "generation", services: [], message: "Generation still needs repair." },
  ]);
});

test("embedded global roots keep independent cleanup receipts", async () => {
  const f = fixture();
  await f.run(
    recordGlobalReconciliation({
      revision: 1,
      operation: "disable",
      contributions: ["mail"],
      servicesRemoved: [],
      pending: [{ phase: "routes", services: ["mail"], message: "Retry." }],
    }),
  );
  const other = await Effect.runPromise(
    readGlobalReconciliation().pipe(Effect.provide(f.layer("/tmp/core4-another-global/root"))),
  );
  expect(other.pending).toEqual([]);
  expect((await f.run(readGlobalReconciliation())).pending).toHaveLength(1);
});

test("incomplete reconciliation is a schema-backed machine-readable receipt", () => {
  const error = new GlobalPolicyReconciliationError({
    message: "Policy saved; routes remain.",
    operation: "disable",
    policySaved: true,
    revision: 3,
    contributions: ["mail"],
    plugins: ["@lando/mail"],
    servicesRemoved: ["mail"],
    pending: [{ phase: "routes", services: ["mail"], message: "Router unavailable." }],
    remediation: "Run global:reconcile after repairing the router.",
    causes: [],
  });
  const decoded = Schema.decodeUnknownSync(GlobalPolicyReconciliationError)(
    JSON.parse(JSON.stringify(error)),
  );
  expect(decoded.policySaved).toBe(true);
  expect(decoded.servicesRemoved).toEqual(["mail"]);
  expect(decoded.pending[0]?.phase).toBe("routes");
});

test("recorded advancement preserves sibling volume and network ownership", async () => {
  const { advanceGlobalRecordedPlan } = await import("../../src/operations/global-retained-plan.ts");
  const { plan } = await import("./global-stop-selection-fixture.ts");
  const sibling = plan.services[ServiceName.make("sibling")];
  const mail = plan.services[ServiceName.make("mail")];
  if (sibling === undefined || mail === undefined) throw new Error("Expected service fixtures");
  const prior = {
    ...plan,
    services: {
      ...plan.services,
      [sibling.name]: {
        ...sibling,
        mounts: [
          {
            type: "volume" as const,
            store: "sibling-data",
            target: PortablePath.make("/data"),
            readOnly: false,
          },
        ],
      },
    },
    stores: [{ name: "sibling-data", scope: "service" as const, kind: "data" as const, driver: "local" }],
    networking: {
      perAppBridge: null,
      sharedNetworkMembership: { name: "shared", aliases: { [sibling.name]: ["prior-sibling"] } },
    },
  };
  const selected = {
    ...plan,
    services: {
      [mail.name]: mail,
    },
    networking: {
      perAppBridge: null,
      sharedNetworkMembership: { name: "shared", aliases: { [sibling.name]: ["unapplied-sibling"] } },
    },
  };
  const recorded = await Effect.runPromise(advanceGlobalRecordedPlan(prior, selected, []));
  expect(recorded.stores).toEqual(prior.stores);
  expect(recorded.services[sibling.name]?.mounts).toEqual(prior.services[sibling.name]?.mounts);
  expect(recorded.networking?.sharedNetworkMembership?.aliases[sibling.name]).toEqual(["prior-sibling"]);
});

test("recorded advancement rejects incompatible shared volume definitions", async () => {
  const { advanceGlobalRecordedPlan } = await import("../../src/operations/global-retained-plan.ts");
  const { plan } = await import("./global-stop-selection-fixture.ts");
  const mail = plan.services[ServiceName.make("mail")];
  const sibling = plan.services[ServiceName.make("sibling")];
  if (mail === undefined || sibling === undefined) throw new Error("Expected service fixtures");
  const mount = {
    type: "volume" as const,
    store: "shared-data",
    target: PortablePath.make("/data"),
    readOnly: false,
  };
  const prior = {
    ...plan,
    services: { [sibling.name]: { ...sibling, mounts: [mount] } },
    stores: [{ name: "shared-data", scope: "app" as const, kind: "data" as const, driver: "local" }],
  };
  const selected = {
    ...plan,
    services: { [mail.name]: { ...mail, mounts: [mount] } },
    stores: [{ name: "shared-data", scope: "app" as const, kind: "data" as const, driver: "changed" }],
  };
  const result = await Effect.runPromise(Effect.result(advanceGlobalRecordedPlan(prior, selected, [])));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure")
    expect(result.failure).toMatchObject({
      _tag: "GlobalAppError",
      message: expect.stringContaining("shared-data"),
    });
});
