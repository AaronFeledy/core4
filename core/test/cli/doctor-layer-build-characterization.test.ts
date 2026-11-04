import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, GlobalAppService, HealthcheckRunner, UrlScanner } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { DefaultGlobalAppDoctorLayer } from "../../src/cli/commands/doctor-global-app.ts";
import { DefaultMcpDoctorLayer } from "../../src/cli/commands/doctor-mcp.ts";
import { DefaultSubsystemDoctorLayer } from "./doctor-subsystem-fixture.ts";

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
      expect(new Set(instances).size).toBe(1);
      const nested = yield* read.pipe(Effect.provide(graph));
      expect(new Set(instances).size).toBe(1);
      expect(nested).toBe(outer);
      expect(yield* read).toBe(outer);
      return outer;
    }).pipe(Effect.provide(graph)),
  );
  const fresh = await Effect.runPromise(read.pipe(Effect.provide(graph)));

  // Then: one build per runtime; a nested provide reuses the parent's memoized build, and a new run rebuilds.
  expect(new Set(instances).size).toBe(2);
  expect(fresh).not.toBe(outer);
};

test("subsystem diagnostics do not manufacture a healthcheck runner", async () => {
  const runner = await Effect.runPromise(
    Effect.serviceOption(HealthcheckRunner).pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
  );
  expect(runner._tag).toBe("None");
});

test("subsystem diagnostics do not manufacture a scanner", async () => {
  const scanner = await Effect.runPromise(
    Effect.serviceOption(UrlScanner).pipe(Effect.provide(DefaultSubsystemDoctorLayer)),
  );
  expect(scanner._tag).toBe("None");
});

test("the global-app doctor layer builds once per runtime", async () => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({});
  const layer = DefaultGlobalAppDoctorLayer.pipe(
    Layer.provide(
      Layer.succeed(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
      ),
    ),
  );
  await characterizeBuilds(layer, GlobalAppService);
});

test("the MCP doctor redaction layer builds once per runtime", async () => {
  await characterizeBuilds(DefaultMcpDoctorLayer, RedactionService);
});
