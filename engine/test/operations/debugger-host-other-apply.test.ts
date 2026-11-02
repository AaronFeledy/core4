import { expect, test } from "bun:test";
import { type AppPlan, DEBUGGER_HOST_ALIAS, GlobalConfig, HOST_GATEWAY_TARGET } from "@lando/sdk/schema";
import { ConfigService, EnvironmentValueResolver, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { applyScratchStartup } from "../../src/scratch-app/startup.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const desired: AppPlan = {
  ...plan,
  services: {
    [web.name]: { ...web, hostAliases: [{ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET }] },
  },
};
const debuggerAlias = (value: AppPlan) => value.services[web.name]?.hostAliases[0]?.ip;
const config = Schema.decodeUnknownSync(GlobalConfig)({ debugger: { host: "192.0.2.40" } });
const configLayer = Layer.succeed(
  ConfigService,
  ConfigService.of({
    load: Effect.succeed(config),
    get: (key) => Effect.succeed(config[key]),
  }),
);

test("scratch startup applies the resolved debugger address without rewriting its input", async () => {
  // Given
  const applied: AppPlan[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: (value) => {
      applied.push(value);
    },
  });
  // When
  await Effect.runPromise(
    Effect.gen(function* () {
      const provider = yield* (yield* RuntimeProviderRegistry).select(desired);
      const environmentResolver = yield* EnvironmentValueResolver;
      yield* applyScratchStartup(
        { id: "debugger-scratch", plan: desired },
        { provider, environmentResolver },
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, configLayer))),
  );
  // Then
  expect(applied.map(debuggerAlias)).toEqual(["192.0.2.40"]);
  expect(debuggerAlias(desired)).toBe(HOST_GATEWAY_TARGET);
});
