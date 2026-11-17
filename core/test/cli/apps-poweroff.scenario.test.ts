import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMaintenanceRegistry } from "@lando/engine/runtime/host-maintenance";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ServiceRuntimeInfo } from "@lando/sdk/services";
import { DateTime, Effect, Layer } from "effect";
import { poweroff, renderPoweroffResult } from "../../src/cli/commands/poweroff.ts";
import { makePoweroffFixture } from "./poweroff-support";

const providerId = ProviderId.make("lando");
let dataRoot: string;

const planAt = (root: string): AppPlan => ({
  id: AppId.make("user-app"),
  name: "user-app",
  slug: "user-app",
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
  app: AppId.make("user-app"),
  appRoot: AbsolutePath.make(root),
  service: ServiceName.make("web"),
  providerId,
  status: "running",
  containerId: "container-web",
  publications: { status: "unknown" },
});

const scratchSummary = (root: string) => ({
  id: "scratch-1",
  app: { kind: "scratch" as const, id: AppId.make("scratch-1"), root: AbsolutePath.make(root) },
  source: { kind: "fork" as const },
  mode: "full" as const,
  created: "2026-08-01T00:00:00.000Z",
  status: "detached" as const,
});

beforeAll(async () => {
  dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-apps-poweroff-")));
});

describe("apps:poweroff command", () => {
  test("stops user apps, destroys scratch apps, then stops the global app", async () => {
    const fixture = await makePoweroffFixture({
      dataRoot,
      services: [serviceAt(dataRoot)],
      appliedPlans: [planAt(dataRoot)],
      scratch: [scratchSummary(dataRoot)],
    });
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(fixture.layer)));
    expect(fixture.calls.slice(0, 3)).toEqual([
      `destroy:${dataRoot}`,
      "scratch:scratch-1",
      "scratch-reason:scratch-1",
    ]);
    expect(result.apps.map((app) => [app.kind, app.outcome])).toEqual([
      ["user", "stopped"],
      ["scratch", "destroyed"],
      ["global", "unchanged"],
    ]);
    expect(fixture.calls.at(-1)).toBe("runtime");
  });

  test("stops the runtime service once after every app", async () => {
    const fixture = await makePoweroffFixture({
      dataRoot,
      services: [serviceAt(dataRoot)],
      appliedPlans: [planAt(dataRoot)],
    });
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(fixture.layer)));
    expect(fixture.calls.filter((call) => call === "runtime")).toHaveLength(1);
    expect(fixture.calls.at(-1)).toBe("runtime");
    expect(result.runtimeServiceStopped).toBe(true);
    expect(result.runtimeServicePid).toBe(4242);
  });

  test("reports a runtime service that stays running", async () => {
    const fixture = await makePoweroffFixture({ dataRoot });
    const layer = Layer.merge(
      fixture.layer,
      Layer.succeed(
        HostMaintenanceRegistry,
        HostMaintenanceRegistry.of({
          maintainers: [
            {
              pluginId: "@lando/test",
              id: "runtime",
              teardown: () => Effect.succeed({ terminated: false }),
            },
          ],
        }),
      ),
    );
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(layer)));
    expect(result.runtimeServiceStopped).toBe(false);
    expect(result.runtimeServicePid).toBeUndefined();
  });

  test("runs host maintenance with runtime paths and reports its pid", async () => {
    const teardownInputs: Parameters<NonNullable<HostMaintenanceContribution["teardown"]>>[0][] = [];
    const fixture = await makePoweroffFixture({ dataRoot });
    const layer = Layer.merge(
      fixture.layer,
      Layer.succeed(
        HostMaintenanceRegistry,
        HostMaintenanceRegistry.of({
          maintainers: [
            {
              pluginId: "@lando/test",
              id: "fake-runtime",
              teardown: (input) => {
                teardownInputs.push(input);
                return Effect.succeed({ terminated: true, pid: 4321 });
              },
            },
          ],
        }),
      ),
    );
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(layer)));
    expect(teardownInputs).toHaveLength(1);
    expect(teardownInputs[0]?.paths.runtimeBinDir).toBe(join(dataRoot, "runtime", "bin"));
    expect(result.runtimeServiceStopped).toBe(true);
    expect(result.runtimeServicePid).toBe(4321);
  });

  test("skips host maintenance when the registry is absent", async () => {
    const fixture = await makePoweroffFixture({ dataRoot });
    const layer = Layer.merge(
      fixture.layer,
      Layer.succeed(HostMaintenanceRegistry, HostMaintenanceRegistry.of({ maintainers: [] })),
    );
    const result = await Effect.runPromise(poweroff().pipe(Effect.provide(layer)));
    expect(result.runtimeServiceStopped).toBe(false);
    expect(result.runtimeServicePid).toBeUndefined();
  });

  test("respects --keep-global and --keep-scratch", async () => {
    const fixture = await makePoweroffFixture({
      dataRoot,
      services: [serviceAt(dataRoot)],
      appliedPlans: [planAt(dataRoot)],
      scratch: [scratchSummary(dataRoot)],
    });
    const result = await Effect.runPromise(
      poweroff({ keepGlobal: true, keepScratch: true }).pipe(Effect.provide(fixture.layer)),
    );
    expect(fixture.calls).toEqual([`destroy:${dataRoot}`]);
    expect(result.apps.filter((app) => app.kind === "user")).toHaveLength(1);
    expect(result.keptGlobalApp).toBe(true);
    expect(result.keptScratchApps).toBe(1);
    expect(result.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
    const rendered = renderPoweroffResult(result);
    expect(rendered).toContain("kept global app running");
    expect(rendered).toContain("kept 1 scratch app running");
  });

  test("render shows the runtime stop line only when the runtime stopped", () => {
    const stopped = renderPoweroffResult({
      apps: [
        {
          kind: "user",
          appId: "user-app",
          appRoot: "/srv/user-app",
          providerId: "lando",
          outcome: "stopped",
          servicesStopped: [],
        },
      ],
      keptGlobalApp: false,
      keptScratchApps: 0,
      runtimeServiceStopped: true,
      runtimeServicePid: 1234,
    });
    expect(stopped).toContain("Stopped Lando runtime service");

    const notStopped = renderPoweroffResult({
      apps: [
        {
          kind: "user",
          appId: "user-app",
          appRoot: "/srv/user-app",
          providerId: "lando",
          outcome: "stopped",
          servicesStopped: [],
        },
      ],
      keptGlobalApp: false,
      keptScratchApps: 0,
      runtimeServiceStopped: false,
    });
    expect(notStopped).not.toContain("Stopped Lando runtime service");
    expect(notStopped).toBe("Powered off: user-app");
  });
});

afterAll(async () => {
  if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
});
