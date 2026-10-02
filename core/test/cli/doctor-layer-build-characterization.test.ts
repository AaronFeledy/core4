import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, GlobalAppService, HealthcheckRunner, UrlScanner } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { DefaultGlobalAppDoctorLayer } from "../../src/cli/commands/doctor-global-app.ts";
import { DefaultMcpDoctorLayer } from "../../src/cli/commands/doctor-mcp.ts";
import { DefaultSubsystemDoctorLayer } from "../../src/cli/commands/doctor-subsystems.ts";

const characterizeBuilds = async <R, S>(live: Layer.Layer<R>, read: Effect.Effect<S, never, R>) => {
  // Given: observe the real doctor graph and also count distinct constructed service objects.
  const instances: S[] = [];
  const layer = live.pipe(
    Layer.tap((context) =>
      read.pipe(
        Effect.provide(context),
        Effect.tap((service) =>
          Effect.sync(() => {
            instances.push(service);
          }),
        ),
      ),
    ),
  );
  const graph = Layer.merge(layer, layer);

  // When: the same layer occurs twice in the graph and is provided again inside one run.
  const outer = await Effect.runPromise(
    Effect.gen(function* () {
      const outer = yield* read;
      expect(yield* read).toBe(outer);
      expect(instances).toHaveLength(1);
      const nested = yield* read.pipe(Effect.provide(graph));
      expect(instances).toHaveLength(2);
      expect(nested).not.toBe(outer);
      expect(yield* read).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(read.pipe(Effect.provide(graph)));

  // Then: Effect 3 rebuilds at both provide boundaries, not within the composed graph.
  expect(instances).toHaveLength(3);
  expect(new Set(instances).size).toBe(3);
  expect(fresh).not.toBe(outer);
};

test("the subsystem doctor healthcheck layer has build counts 1, 2, 3", async () => {
  await characterizeBuilds(DefaultSubsystemDoctorLayer, HealthcheckRunner);
});

test("the subsystem doctor scanner layer has build counts 1, 2, 3", async () => {
  await characterizeBuilds(DefaultSubsystemDoctorLayer, UrlScanner);
});

test("the global-app doctor layer has build counts 1, 2, 3", async () => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = DefaultGlobalAppDoctorLayer.pipe(
    Layer.provide(
      Layer.succeed(ConfigService, {
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    ),
  );
  await characterizeBuilds(layer, GlobalAppService);
});

test("the MCP doctor redaction layer has build counts 1, 2, 3", async () => {
  await characterizeBuilds(DefaultMcpDoctorLayer, RedactionService);
});
