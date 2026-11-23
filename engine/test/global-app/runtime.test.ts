import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  LANDO_DATA_ROOT_LABEL,
  PortNumber,
  ProviderId,
  ServiceName,
  planAppIdentity,
} from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as GlobalAppRuntime from "../../src/global-app/runtime.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeHarness } from "../operations/start-progress-topology-support.ts";

test.each(["idle", "running", "foreign", "stopped", "status-error", "list-error", "restart-error"] as const)(
  "global reload preserves runtime state and failures for %s",
  async (mode) => {
    const actions: string[] = [];
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "reload-test",
      message: "runtime failed",
      remediation: "Repair runtime.",
    });
    const harness = makeHarness({ globalServiceIds: ["traefik"] });
    const base = harness.globalAdmission.globalPlan;
    const dataRoot = AbsolutePath.make(harness.userDataRoot);
    const plan = { ...base, identity: { ...planAppIdentity(base), dataRoot } };
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: plan.provider,
      getStatus:
        mode === "status-error"
          ? Effect.fail(failure)
          : Effect.succeed({ state: mode === "idle" ? "idle" : "running" }),
      ensureReady: Effect.die("reload must not start the runtime"),
      list: () =>
        Effect.suspend(() => {
          actions.push("list");
          return mode === "idle" || mode === "list-error"
            ? Effect.fail(failure)
            : Effect.succeed([
                {
                  app: AppId.make("global"),
                  appRoot: plan.root,
                  containerId: "router",
                  labels: {
                    "dev.lando.app": "global",
                    "dev.lando.app-root": plan.root,
                    "dev.lando.service": "traefik",
                    [LANDO_DATA_ROOT_LABEL]: mode === "foreign" ? "/other-data-root" : dataRoot,
                  },
                  providerId: ProviderId.make("lando"),
                  service: ServiceName.make("traefik"),
                  status: mode === "stopped" ? "exited" : "running",
                  publications: { status: "unknown" as const },
                },
              ]);
        }),
      restart: () =>
        Effect.suspend(() => {
          actions.push("restart");
          return mode === "restart-error" ? Effect.fail(failure) : Effect.void;
        }),
    };
    const runtime = GlobalAppRuntime.layer.pipe(
      Layer.provide(
        Layer.succeed(
          RuntimeProviderRegistry,
          makeTestRuntimeProviderRegistry({
            ...harness.runtimeProviderRegistry,
            resolveAppliedPlan: () => Effect.succeed(plan),
            select: () => Effect.succeed(provider),
          }),
        ),
      ),
      Layer.provide(harness.layer),
      Layer.provide(BunFileSystem.layer),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const global = yield* GlobalAppService;
        if (global.restartRunningService === undefined) return yield* Effect.die("runtime reload missing");
        return yield* global.restartRunningService(ServiceName.make("traefik"));
      }).pipe(Effect.provide(runtime), Effect.result),
    );

    if (mode.endsWith("-error")) {
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "GlobalAppError",
          operation: "restartRunningService",
          cause: failure,
        },
      });
    } else {
      expect(result).toMatchObject({ _tag: "Success", success: mode === "running" });
    }
    expect(actions).toEqual(
      mode === "idle" || mode === "status-error"
        ? []
        : mode === "stopped" || mode === "list-error" || mode === "foreign"
          ? ["list"]
          : ["list", "restart"],
    );
  },
);

test.each([true, false])(
  "Docker credits local ports only with the local data-root label (%s)",
  async (labeled) => {
    const harness = makeHarness({ globalServiceIds: ["traefik"] });
    const base = harness.globalAdmission.globalPlan;
    const dataRoot = AbsolutePath.make(harness.userDataRoot);
    const docker = ProviderId.make("docker");
    const plan = { ...base, provider: docker, identity: { ...planAppIdentity(base), dataRoot } };
    const service = ServiceName.make("traefik");
    const ports = [80, 443, 8080, 8443].map((port) => PortNumber.make(port));
    const row = (
      appRoot: AbsolutePath,
      labels: Readonly<Record<string, string>>,
      hostPorts: readonly number[],
    ) => ({
      app: plan.id,
      appRoot,
      labels: {
        "dev.lando.app": "global",
        "dev.lando.app-root": appRoot,
        "dev.lando.service": service,
        ...labels,
      },
      service,
      providerId: docker,
      status: "running" as const,
      containerId: appRoot,
      publications: {
        status: "present" as const,
        bindings: hostPorts.map((hostPort) => ({
          bindAddress: "0.0.0.0",
          port: PortNumber.make(hostPort),
          hostPort: PortNumber.make(hostPort),
          transport: "tcp" as const,
        })),
      },
    });
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
      id: docker,
      list: () =>
        Effect.succeed([
          row(
            AbsolutePath.make("/other-data-root/global"),
            { [LANDO_DATA_ROOT_LABEL]: "/other-data-root" },
            [80, 443],
          ),
          row(plan.root, labeled ? { [LANDO_DATA_ROOT_LABEL]: dataRoot } : {}, [8080, 8443]),
        ]),
    };
    const runtime = GlobalAppRuntime.layer.pipe(
      Layer.provide(
        Layer.succeed(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          appliedPlansFor: (root) => Effect.succeed(root === plan.root ? [plan] : []),
          resolveAppliedPlan: (root) => Effect.succeed(root === plan.root ? plan : undefined),
          select: () => Effect.succeed(provider),
        }),
      ),
      Layer.provide(harness.layer),
      Layer.provide(BunFileSystem.layer),
    );
    const owned = await Effect.runPromise(
      Effect.gen(function* () {
        const global = yield* GlobalAppService;
        if (global.ownedPublishPorts === undefined)
          return yield* Effect.die("missing port ownership operation");
        return yield* global.ownedPublishPorts(service, ports);
      }).pipe(Effect.provide(runtime)),
    );
    expect(owned).toEqual(labeled ? [8080, 8443] : []);
  },
);
