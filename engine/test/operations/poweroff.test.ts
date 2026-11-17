import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import type { ProviderRuntimeSnapshot, ServiceRuntimeInfo } from "@lando/sdk/services";
import {
  AppPlanner,
  ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  ScratchAppService,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { DateTime, Effect, Layer } from "effect";
import { poweroff } from "../../src/operations/poweroff.ts";
import { HostMaintenanceRegistry } from "../../src/runtime/host-maintenance.ts";
import { globalTeardownHarness } from "../../src/testing/global-teardown.ts";
import { layerTransactionGuard } from "../services/landofile-layer.ts";
import { emptySnapshotsLayer } from "./data-mover-support.ts";

const providerId = ProviderId.make("lando");
const dataRoot = await mkdtemp(join(tmpdir(), "lando-poweroff-data-"));
afterAll(() => rm(dataRoot, { recursive: true, force: true }));

const ownerKey = (root: string): string => appIdentityKey("owner", root);

const planAt = (root: string, id = "twin"): AppPlan => ({
  id: AppId.make(id),
  name: id,
  slug: id,
  root: AbsolutePath.make(root),
  identity: { appRoot: AbsolutePath.make(root), ownerKey: ownerKey(root) },
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

const serviceAt = (root: string, app: string, status: ServiceRuntimeInfo["status"]): ServiceRuntimeInfo => ({
  app: AppId.make(app),
  appRoot: AbsolutePath.make(root),
  service: ServiceName.make("web"),
  providerId,
  status,
  containerId: `${app}-web`,
  publications: { status: "unknown" as const },
});

const fakeConfigService = Layer.succeed(
  ConfigService,
  ConfigService.of({
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never),
);

const makeHarness = async (input: {
  readonly roots: ReadonlyArray<{
    readonly root: string;
    readonly plan: AppPlan;
    readonly status: ServiceRuntimeInfo["status"];
  }>;
  readonly quiescent?: { readonly root: string; readonly plan: AppPlan };
  readonly failRoot?: string;
}) => {
  const teardown = await globalTeardownHarness(dataRoot);
  const calls: string[] = [];
  const failures = new Map<string, ProviderUnavailableError>();
  if (input.failRoot !== undefined)
    failures.set(
      input.failRoot,
      new ProviderUnavailableError({
        providerId,
        operation: "destroy",
        message: `Cannot stop the app at ${input.failRoot}.`,
        remediation: "Restore provider access and retry `lando poweroff`.",
      }),
    );
  const plans = new Map(input.roots.map((entry) => [entry.root, entry.plan]));
  const services: ServiceRuntimeInfo[] = input.roots.map((entry) =>
    serviceAt(entry.root, String(entry.plan.id), entry.status),
  );
  if (input.quiescent !== undefined)
    services.push(serviceAt(input.quiescent.root, String(input.quiescent.plan.id), "exited"));
  const snapshot: ProviderRuntimeSnapshot = {
    providerId,
    runtimeObserved: true,
    appliedPlans: [],
    services,
    volumes: [],
  };
  const provider = {
    ...TestRuntimeProvider,
    id: "lando",
    appliedPlans: Effect.succeed([]),
    list: () => Effect.succeed([]),
    listVolumes: () => Effect.succeed([]),
    destroy: (target: { readonly app: string; readonly plan?: AppPlan }) =>
      Effect.gen(function* () {
        calls.push(`destroy:${target.plan?.root ?? "global"}`);
        const failure = target.plan === undefined ? undefined : failures.get(String(target.plan.root));
        if (failure !== undefined) return yield* Effect.fail(failure);
        return { kind: "destroyed" as const };
      }),
  };
  const registry = {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
    appliedStateInventory: () => Effect.succeed({ plans: [], unreadable: [] }),
    observeRuntime: Effect.succeed([snapshot]),
    appliedPlansFor: (root: AbsolutePath, scope?: ProviderId) =>
      Effect.succeed(
        (scope === undefined || scope === providerId) && plans.has(root) ? [plans.get(root) as AppPlan] : [],
      ),
    resolveAppliedPlan: () => Effect.succeed(undefined),
    resolveTeardownEvidence: (root: AbsolutePath) =>
      Effect.succeed(
        plans.has(root)
          ? { kind: "applied" as const, plan: plans.get(root) as AppPlan }
          : { kind: "absent" as const },
      ),
    resourceOwnership: () => Effect.succeed(undefined),
    select: () => Effect.succeed(provider),
  };
  const scratch = Layer.succeed(
    ScratchAppService,
    ScratchAppService.of({
      kind: "scratch",
      root: Effect.succeed(AbsolutePath.make(dataRoot)),
      ensureRoot: Effect.die("unexpected ensureRoot"),
      synthesizeId: () => Effect.die("unexpected synthesizeId"),
      paths: () => Effect.die("unexpected paths"),
      acquire: () => Effect.die("unexpected acquire"),
      resolveById: () => Effect.die("unexpected resolve"),
      list: () => Effect.succeed([]),
      info: () => Effect.die("unexpected info"),
      start: () => Effect.die("unexpected start"),
      stop: () => Effect.die("unexpected stop"),
      destroy: () => Effect.die("unexpected destroy"),
      gc: () => Effect.die("unexpected gc"),
    }),
  );
  const runtime = Layer.succeed(
    HostMaintenanceRegistry,
    HostMaintenanceRegistry.of({
      maintainers: [
        {
          pluginId: "@lando/test",
          id: "runtime",
          teardown: () => {
            calls.push("runtime");
            return Effect.succeed({ terminated: true, pid: 4242 });
          },
        },
      ],
    }),
  );
  const invalidLandofile = new LandofileValidationError({
    message: "The current Landofile is invalid.",
    remediation: "Fix the current Landofile before applying it.",
    file: ".lando.yml",
    issues: [{ path: [], message: "invalid test fixture" }],
  });
  const fakeLandofile = Layer.succeed(
    LandofileService,
    LandofileService.of({ discover: Effect.fail(invalidLandofile) }),
  );
  const planner = Layer.succeed(
    AppPlanner,
    AppPlanner.of({ plan: () => Effect.die("no desired plan may be built during poweroff inventory") }),
  );
  const layer = Layer.mergeAll(
    teardown.layer,
    layerTransactionGuard,
    emptySnapshotsLayer,
    fakeConfigService,
    scratch,
    runtime,
    fakeLandofile,
    planner,
    Layer.succeed(RuntimeProviderRegistry, registry as never),
  );
  return { layer, calls };
};

const withRoots = async <A>(
  use: (roots: { readonly a: string; readonly b: string; readonly quiet: string }) => Promise<A>,
): Promise<A> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "lando-poweroff-")));
  const a = join(parent, "a");
  const b = join(parent, "b");
  const quiet = join(parent, "quiet");
  await Promise.all(
    [a, b, quiet].map(async (root) => {
      await Bun.write(join(root, ".lando.yml"), `name: ${root === quiet ? "quiet" : "twin"}\n`).catch(
        async () => {
          await import("node:fs/promises").then(({ mkdir }) => mkdir(root, { recursive: true }));
          await writeFile(join(root, ".lando.yml"), `name: ${root === quiet ? "quiet" : "twin"}\n`);
        },
      );
    }),
  );
  try {
    return await use({ a, b, quiet });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
};

describe("poweroff operation", () => {
  test("stops two apps with the same id at different roots", async () => {
    await withRoots(async ({ a, b, quiet }) => {
      const harness = await makeHarness({
        roots: [
          { root: a, plan: planAt(a), status: "running" },
          { root: b, plan: planAt(b), status: "running" },
        ],
        quiescent: { root: quiet, plan: planAt(quiet, "quiet") },
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      const users = result.apps.filter((app) => app.kind === "user");
      expect(users.map((app) => app.appRoot).sort()).toEqual([a, b].sort());
      expect(users.every((app) => app.outcome === "stopped")).toBe(true);
      expect(harness.calls.filter((call) => call.startsWith("destroy:"))).toHaveLength(2);
      expect(harness.calls).not.toContain(`destroy:${quiet}`);
    });
  });

  test("skips a quiescent persisted app so its stop hook never runs", async () => {
    await withRoots(async ({ a, quiet }) => {
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "running" }],
        quiescent: { root: quiet, plan: planAt(quiet, "quiet") },
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      expect(result.apps.filter((app) => app.kind === "user").map((app) => app.appId)).toEqual(["twin"]);
      expect(harness.calls).not.toContain(`destroy:${quiet}`);
      expect(harness.calls.filter((call) => call.startsWith("destroy:"))).toEqual([`destroy:${a}`]);
    });
  });

  test("continues past one user failure and skips global and runtime teardown", async () => {
    await withRoots(async ({ a, b }) => {
      const harness = await makeHarness({
        roots: [
          { root: a, plan: planAt(a), status: "running" },
          { root: b, plan: planAt(b), status: "running" },
        ],
        failRoot: a,
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.result, Effect.provide(harness.layer)));
      expect(result._tag).toBe("Failure");
      if (result._tag !== "Failure") throw new Error("expected a typed poweroff failure");
      if (result.failure._tag !== "PoweroffStopError")
        throw new TypeError(`expected PoweroffStopError, received ${result.failure._tag}`);
      expect(result.failure).toMatchObject({
        _tag: "PoweroffStopError",
        failures: [
          {
            kind: "user",
            appRoot: a,
            errorTag: "ProviderUnavailableError",
            remediation: "Restore provider access and retry `lando poweroff`.",
          },
        ],
      });
      expect(result.failure.apps.some((app) => app.kind === "user" && app.appRoot === b)).toBe(true);
      expect(result.failure.apps.find((app) => app.kind === "global")?.outcome).toBe("skipped");
      expect(harness.calls).not.toContain("runtime");
    });
  });

  test("keeps the runtime service when --keep-global is set", async () => {
    await withRoots(async ({ a }) => {
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "running" }],
      });
      const result = await Effect.runPromise(
        poweroff({ keepGlobal: true }).pipe(Effect.provide(harness.layer)),
      );
      expect(result.keptGlobalApp).toBe(true);
      expect(harness.calls).not.toContain("runtime");
    });
  });

  test("stops the runtime service once, after every app and the global stop", async () => {
    await withRoots(async ({ a }) => {
      const harness = await makeHarness({
        roots: [{ root: a, plan: planAt(a), status: "running" }],
      });
      const result = await Effect.runPromise(poweroff().pipe(Effect.provide(harness.layer)));
      expect(result.runtimeServiceStopped).toBe(true);
      expect(result.runtimeServicePid).toBe(4242);
      expect(harness.calls.filter((call) => call === "runtime")).toHaveLength(1);
      expect(harness.calls.at(-1)).toBe("runtime");
    });
  });
});
