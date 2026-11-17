import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { AppliedOrphanGroup, ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Effect } from "effect";
import { poweroffSpec } from "../../src/cli/command-specs/apps/poweroff";
import { poweroff, renderPoweroffResult } from "../../src/cli/commands/poweroff";
import { makePoweroffFixture } from "./poweroff-support";

const providerId = ProviderId.make("lando");

const planAt = (root: string): AppPlan => ({
  id: AppId.make("poweroff-app"),
  name: "poweroff-app",
  slug: "poweroff-app",
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: appIdentityKey("owner", root) },
  provider: providerId,
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
    source: "applied-state",
    runtime: 4,
  },
  extensions: {},
});

const serviceAt = (root: string): ServiceRuntimeInfo => ({
  app: AppId.make("poweroff-app"),
  appRoot: AbsolutePath.make(root),
  service: ServiceName.make("web"),
  providerId,
  status: "running",
  containerId: "container-web",
  publications: { status: "unknown" },
});

const orphanAt = (root: string): AppliedOrphanGroup => ({
  providerId,
  appId: AppId.make("poweroff-app"),
  services: [serviceAt(root)],
  volumes: [],
});

const withRoot = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-poweroff-production-")));
  await mkdir(join(root, "conf"), { recursive: true });
  await Bun.write(join(root, ".lando.yml"), "name: poweroff-app\n");
  try {
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("stops orphaned containers of an app without applied state", async () => {
  await withRoot(async (root) => {
    // Given an app whose containers are running but whose applied record is gone.
    const fixture = await makePoweroffFixture({
      dataRoot: root,
      services: [serviceAt(root)],
      orphans: [orphanAt(root)],
    });
    // When the production command powers off.
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(fixture.layer)));
    // Then the stop lifecycle removes the orphan without a bare provider destroy.
    expect(result.apps).toEqual([
      {
        kind: "user",
        appId: "poweroff-app",
        appRoot: root,
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: ["web"],
      },
      {
        kind: "global",
        appId: "global",
        appRoot: join(root, "global"),
        providerId: "lando",
        outcome: "unchanged",
        servicesStopped: [],
      },
    ]);
    expect(fixture.calls).toEqual(["remove:web", "runtime"]);
    expect(result.runtimeServiceStopped).toBe(true);
  });
});

test("aggregates a failed app and skips runtime shutdown", async () => {
  await withRoot(async (root) => {
    const fixture = await makePoweroffFixture({
      dataRoot: root,
      services: [serviceAt(root)],
      appliedPlans: [planAt(root)],
      destroyFailureRoot: root,
    });
    const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(fixture.layer)));
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
    if (result.failure._tag !== "PoweroffStopError")
      throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
    expect(result.failure).toMatchObject({
      _tag: "PoweroffStopError",
      failures: [
        {
          kind: "user",
          appId: "poweroff-app",
          appRoot: root,
          errorTag: "ProviderUnavailableError",
        },
      ],
    });
    expect(result.failure.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
    expect(fixture.calls).not.toContain("runtime");
  });
});

test("reports keep flags and leaves the runtime service running", async () => {
  await withRoot(async (root) => {
    const fixture = await makePoweroffFixture({
      dataRoot: root,
      services: [serviceAt(root)],
      appliedPlans: [planAt(root)],
      scratch: [
        {
          id: "scratch-one",
          app: { kind: "scratch", id: AppId.make("scratch-one"), root: AbsolutePath.make(root) },
          source: { kind: "fork" },
          mode: "full",
          created: "2026-08-01T00:00:00.000Z",
          status: "detached",
        },
      ],
    });
    const result = await Effect.runPromise(
      poweroff({ keepGlobal: true, keepScratch: true }).pipe(Effect.provide(fixture.layer)),
    );
    expect(result.keptGlobalApp).toBe(true);
    expect(result.keptScratchApps).toBe(1);
    expect(result.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
    expect(fixture.calls).not.toContain("runtime");
    const rendered = renderPoweroffResult(result);
    expect(rendered).toContain("kept global app running");
    expect(rendered).toContain("kept 1 scratch app running");
  });
});

test("renders duplicate ids with their roots and the runtime line only when stopped", () => {
  const rendered = renderPoweroffResult({
    apps: [
      {
        kind: "user",
        appId: "twin",
        appRoot: "/one",
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: [],
      },
      {
        kind: "user",
        appId: "twin",
        appRoot: "/two",
        providerId: "lando",
        outcome: "stopped",
        servicesStopped: [],
      },
      {
        kind: "global",
        appId: "global",
        appRoot: "/global",
        providerId: "lando",
        outcome: "unchanged",
      },
    ],
    keptGlobalApp: false,
    keptScratchApps: 0,
    runtimeServiceStopped: true,
    runtimeServicePid: 1234,
  });
  expect(rendered).toBe(
    ["Powered off: twin (/one), twin (/two), global", "Stopped Lando runtime service"].join("\n"),
  );
});

test("provides the scratch bootstrap tier through command metadata", () => {
  expect(poweroffSpec.bootstrap).toBe("scratch");
  expect(poweroffSpec.flags?.yes).toBeDefined();
});
