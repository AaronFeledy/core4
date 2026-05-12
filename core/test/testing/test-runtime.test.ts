import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer, Option } from "effect";

import { ConfigService, FileSystem, Logger, ProcessRunner, RuntimeProvider } from "@lando/core/services";
import { TestRuntimeProvider, makeTestRuntime, provideTestRuntime } from "@lando/core/testing";

describe("@lando/core/testing", () => {
  test("makeTestRuntime provides in-memory service doubles and records calls", async () => {
    const runtime = makeTestRuntime({ files: { "/app/.lando.yml": "name: app" } });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const logger = yield* Logger;
        const fileSystem = yield* FileSystem;
        const processRunner = yield* ProcessRunner;
        const config = yield* ConfigService;

        yield* logger.info("boot", { bootstrap: "minimal" });
        const content = yield* fileSystem.readFile("/app/.lando.yml");
        yield* fileSystem.writeAtomic("/tmp/generated", "ok");
        const processResult = yield* processRunner.spawn({ args: ["lando", "version"], cwd: "/app" });
        const globalConfig = yield* config.load;

        return { content, processResult, globalConfig };
      }).pipe(Effect.provide(runtime.layer)),
    );

    expect(result.content).toBe("name: app");
    expect(result.processResult).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(result.globalConfig.telemetry).toEqual({ enabled: false });
    expect(runtime.calls.logger).toEqual([
      { level: "info", message: "boot", data: { bootstrap: "minimal" } },
    ]);
    expect(runtime.calls.fileSystem).toEqual([
      { operation: "readFile", path: "/app/.lando.yml" },
      { operation: "writeAtomic", path: "/tmp/generated", content: "ok" },
    ]);
    expect(runtime.calls.processRunner).toEqual([{ args: ["lando", "version"], cwd: "/app" }]);
    expect(runtime.calls.config).toEqual(["load"]);
    expect(runtime.files.get("/tmp/generated")).toBe("ok");
  });

  test("provideTestRuntime returns a Layer with default config", async () => {
    const config = await Effect.runPromise(
      Effect.flatMap(ConfigService, (service) => service.load).pipe(
        Effect.provide(provideTestRuntime({ bootstrap: "minimal" })),
      ),
    );

    expect(config.telemetry).toEqual({ enabled: false });
  });

  test("provider bootstrap supports RuntimeProvider overrides", async () => {
    const context = await Effect.runPromise(
      Effect.scoped(
        Layer.build(
          provideTestRuntime({
            bootstrap: "provider",
            with: { RuntimeProvider: TestRuntimeProvider },
          }),
        ),
      ),
    );

    expect(Option.isSome(Context.getOption(context, RuntimeProvider))).toBe(true);
  });
});
