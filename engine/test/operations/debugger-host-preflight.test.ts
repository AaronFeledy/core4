import { expect, test } from "bun:test";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { type AppPlan, DEBUGGER_HOST_ALIAS, GlobalConfig, HOST_GATEWAY_TARGET } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { DateTime, Effect, Layer, Schema } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { applyDebuggerHost } from "../../src/subsystems/debugger-host.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const desired: AppPlan = {
  ...plan,
  services: {
    [web.name]: { ...web, hostAliases: [{ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET }] },
  },
};
const target = {
  plan: desired,
  root: desired.root,
  app: { kind: "user" as const, id: desired.id, root: desired.root },
};
const configLayer = (host: string) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host } });
  return Layer.succeed(
    ConfigService,
    ConfigService.of({
      load: Effect.succeed(config),
      get: (key) => Effect.succeed(config[key]),
    }),
  );
};
const runningPlan = applyDebuggerHost(desired, "192.0.2.40");
const runningService = Object.values(runningPlan.services)[0];
if (runningService === undefined) throw new TypeError("Missing fixture service");
const labels = commonContainerLabels(runningPlan, runningService);

for (const [host, succeeds] of [
  ["192.0.2.40", true],
  ["192.0.2.41", false],
] as const) {
  test(`selected restart ${succeeds ? "accepts unchanged" : "rejects changed"} debugger address before stopping`, async () => {
    // Given
    const stopped: string[] = [];
    const harness = makeHarness({
      plannedApp: desired,
      resolveAppliedPlan: () => Effect.succeed(desired),
      onStop: () => {
        stopped.push("stop");
      },
      inspect: (request) =>
        Effect.succeed({
          app: desired.id,
          service: request.service,
          providerId: desired.provider,
          status: "running",
          state: "running",
          containerId: "php",
          labels,
          lastStartedAt: DateTime.toDate(DateTime.makeUnsafe(0)),
          publications: { status: "unknown" },
        }),
    });
    // When
    const result = await Effect.runPromise(
      restartApp({ services: [web.name] }, target).pipe(
        Effect.provide(Layer.merge(harness.layer, configLayer(host))),
        Effect.result,
      ),
    );
    // Then
    expect(result._tag).toBe(succeeds ? "Success" : "Failure");
    expect(stopped).toHaveLength(succeeds ? 1 : 0);
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        _tag: "ServiceRestartWouldRecreateError",
        reason: "config",
      });
  });
}

for (const operation of ["start", "rebuild", "restart"] as const) {
  test(`${operation} rejects unavailable debugger discovery before provider mutation`, async () => {
    // Given
    const mutations: string[] = [];
    const harness = makeHarness({
      plannedApp: desired,
      resolveAppliedPlan: () => Effect.succeed(desired),
      onStop: () => {
        mutations.push("stop");
      },
      onApply: () => {
        mutations.push("apply");
      },
      onDestroy: () => {
        mutations.push("destroy");
      },
    });
    const run =
      operation === "start"
        ? startApp({}, target)
        : operation === "rebuild"
          ? rebuildApp({ services: [web.name] }, target)
          : restartApp({ services: [web.name] }, target);
    // When
    const result = await Effect.runPromise(
      run.pipe(Effect.provide(Layer.merge(harness.layer, configLayer("windows"))), Effect.result),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DebuggerHostUnavailableError" } });
    expect(mutations).toEqual([]);
  });
}

for (const operation of ["start", "rebuild", "restart"] as const) {
  test(`whole-app ${operation} carries one debugger preflight result through mutation and apply`, async () => {
    // Given
    let reads = 0;
    const addresses: (string | undefined)[] = [];
    const config = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host: "192.0.2.40" } });
    const layer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) =>
          Effect.sync(() => {
            if (key === "debugger") {
              reads++;
              if (reads > 1) throw new TypeError("Debugger discovery repeated after mutation");
            }
            return config[key];
          }),
      }),
    );
    const harness = makeHarness({
      plannedApp: desired,
      resolveAppliedPlan: () => Effect.succeed(desired),
      onApply: (value) => {
        addresses.push(value.services[web.name]?.hostAliases[0]?.ip);
      },
      onStop: () => {
        expect(reads).toBe(1);
      },
    });
    const run =
      operation === "start"
        ? startApp({}, target)
        : operation === "rebuild"
          ? rebuildApp({}, target)
          : restartApp({}, target);
    // When
    await Effect.runPromise(run.pipe(Effect.provide(Layer.merge(harness.layer, layer))));
    // Then
    expect(reads).toBe(1);
    expect(addresses).toEqual(["192.0.2.40"]);
  });
}
