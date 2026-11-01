import { expect, test } from "bun:test";
import { type AppPlan, DEBUGGER_HOST_ALIAS, GlobalConfig, HOST_GATEWAY_TARGET } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, runStart, web } from "./start-progress-topology-support.ts";

const debuggerConsumer = (): AppPlan => ({
  ...plan,
  services: {
    [web.name]: {
      ...web,
      hostAliases: [
        { hostname: "host.lando.internal", ip: HOST_GATEWAY_TARGET },
        { hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET },
      ],
    },
  },
});

const withDebuggerConfig = <E, R>(layer: Layer.Layer<R, E>, host: string) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host } });
  return Layer.mergeAll(
    layer,
    Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    ),
  );
};

const debuggerAlias = (appPlan: AppPlan) =>
  appPlan.services[web.name]?.hostAliases.find((alias) => alias.hostname === DEBUGGER_HOST_ALIAS);

test("start resolves debugger host before apply and keeps the gateway sentinel on the desired plan", async () => {
  // Given
  const desired = debuggerConsumer();
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: (appPlan) => {
      applied.push(appPlan);
    },
  });

  // When
  await Effect.runPromise(
    startApp(
      {},
      {
        plan: desired,
        root: desired.root,
        app: { kind: "user", id: desired.id, root: desired.root },
      },
    ).pipe(Effect.provide(withDebuggerConfig(harness.layer, "192.0.2.40"))),
  );

  // Then apply carries the resolved address while the desired plan stays neutral.
  expect(applied).toHaveLength(1);
  expect(applied.map(debuggerAlias)).toEqual([{ hostname: DEBUGGER_HOST_ALIAS, ip: "192.0.2.40" }]);
  expect(debuggerAlias(desired)).toEqual({ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET });
});

test("selected restart overlays debugger host for apply after retained agent mounts", async () => {
  // Given
  const desired = debuggerConsumer();
  const appliedRecord = desired;
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    resolveAppliedPlan: () => Effect.succeed(appliedRecord),
    onApply: (appPlan) => {
      applied.push(appPlan);
    },
  });

  // When
  await Effect.runPromise(
    restartApp(
      { services: [web.name] },
      {
        plan: desired,
        root: desired.root,
        app: { kind: "user", id: desired.id, root: desired.root },
      },
    ).pipe(Effect.provide(withDebuggerConfig(harness.layer, "2001:db8::40"))),
  );

  // Then
  expect(applied).toHaveLength(1);
  expect(applied.map(debuggerAlias)).toEqual([{ hostname: DEBUGGER_HOST_ALIAS, ip: "2001:db8::40" }]);
});

test("selected rebuild applies debugger host on the runtime plan only", async () => {
  // Given
  const desired = debuggerConsumer();
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: (appPlan) => {
      applied.push(appPlan);
    },
  });

  // When
  await Effect.runPromise(
    rebuildApp(
      { services: [web.name] },
      {
        plan: desired,
        root: desired.root,
        app: { kind: "user", id: desired.id, root: desired.root },
      },
    ).pipe(Effect.provide(withDebuggerConfig(harness.layer, "192.0.2.77"))),
  );

  // Then
  expect(applied).toHaveLength(1);
  expect(applied.map(debuggerAlias)).toEqual([{ hostname: DEBUGGER_HOST_ALIAS, ip: "192.0.2.77" }]);
  expect(debuggerAlias(desired)).toEqual({ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET });
});

test("start leaves debugger host neutral when config is unset", async () => {
  // Given
  const desired = debuggerConsumer();
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: (appPlan) => {
      applied.push(appPlan);
    },
  });

  // When
  await runStart(harness, desired);

  // Then
  expect(applied).toHaveLength(1);
  expect(applied.map(debuggerAlias)).toEqual([{ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET }]);
});
