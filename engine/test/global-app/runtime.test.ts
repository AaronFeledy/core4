import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as GlobalAppRuntime from "../../src/global-app/runtime.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { makeHarness } from "../operations/start-progress-topology-support.ts";

test.each(["idle", "running", "stopped", "status-error", "list-error", "restart-error"] as const)(
  "global reload preserves runtime state and failures for %s",
  async (mode) => {
    const actions: string[] = [];
    const failure = new ProviderUnavailableError({
      providerId: "lando",
      operation: "reload-test",
      message: "runtime failed",
      remediation: "Repair runtime.",
    });
    const harness = makeHarness();
    const provider: RuntimeProviderShape = {
      ...TestRuntimeProvider,
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
        Layer.succeed(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          select: () => Effect.succeed(provider),
        }),
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
        : mode === "stopped" || mode === "list-error"
          ? ["list"]
          : ["list", "restart"],
    );
  },
);
