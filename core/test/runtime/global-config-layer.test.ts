import { expect, test } from "bun:test";
import { ConfigError } from "@lando/sdk/errors";
import { ConfigService, PathsService } from "@lando/sdk/services";
import { Effect, Result } from "effect";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { withEnvVar } from "../_support/temp-cwd.ts";

test("library host config reaches ConfigService beyond the old override subset", async () => {
  // Given a hermetic host config with a previously unsupported router field.
  const layer = makeLandoRuntime({
    bootstrap: "minimal",
    configSources: { user: false, env: false },
    config: {
      router: { httpPort: 8123 },
      appEnv: { CUSTOM: "host" },
      userDataRoot: "/host/lando-data",
    },
  });
  // When a real runtime exposes config and paths to a consumer.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const config = yield* (yield* ConfigService).load;
      const paths = yield* PathsService;
      return { config, roots: paths.roots };
    }).pipe(Effect.provide(layer)),
  );
  // Then arbitrary host fields survive and both services share the root authority.
  expect(result.config.router?.httpPort).toBe(8123);
  expect(result.config.appEnv).toEqual({ CUSTOM: "host" });
  expect(String(result.config.userDataRoot)).toBe("/host/lando-data");
  expect(result.roots.userDataRoot).toBe("/host/lando-data");
});

test("invalid library host config produces ConfigError with host provenance", async () => {
  // Given a host port outside the schema range.
  const layer = makeLandoRuntime({
    bootstrap: "minimal",
    configSources: { user: false, env: false },
    config: { router: { httpPort: 99999 } },
  });
  // When the consumer loads config from that runtime.
  const result = await Effect.runPromise(
    Effect.result(Effect.flatMap(ConfigService, (service) => service.load).pipe(Effect.provide(layer))),
  );
  // Then the host value fails in the canonical decoder, not runtime-option bootstrap.
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) throw new Error("Expected config failure");
  expect(result.failure).toBeInstanceOf(ConfigError);
  if (!(result.failure instanceof ConfigError)) throw new Error("Expected ConfigError");
  expect(result.failure.issues?.[0]?.source).toEqual({ layer: "host", path: ["router", "httpPort"] });
  expect(result.failure.issues?.[0]?.suggestion).toBe("Fix the `router.httpPort` host config option");
});

test("runtime config uses the environment captured by its own construction", async () => {
  await withEnvVar("LANDO_ROUTER_HTTP_PORT", "8125", async () => {
    // Given a runtime constructed before the ambient environment changes.
    const runtime = makeLandoRuntime({ bootstrap: "minimal", configSources: { user: false } });
    // When a later environment owner loads config from the earlier runtime.
    const config = await withEnvVar("LANDO_ROUTER_HTTP_PORT", "8126", () =>
      Effect.runPromise(
        Effect.flatMap(ConfigService, (service) => service.load).pipe(Effect.provide(runtime)),
      ),
    );
    // Then the runtime's explicit input wins over later ambient process state.
    expect(config.router?.httpPort).toBe(8125);
  });
});
