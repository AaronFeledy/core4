import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigService, PathsService } from "@lando/sdk/services";
import { Context, Effect, Layer } from "effect";
import { resilientDoctorReport } from "../../src/cli/commands/doctor-bootstrap";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

test("app runtime acquires config once and pins reads after the source changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-config-snapshot-"));
  const file = join(root, "config.yml");
  await writeFile(file, "router:\n  httpPort: 8123\n");
  const acquisitionModule: typeof import("@lando/paths/config-sources") = await import(
    Bun.resolveSync(
      "@lando/paths/config-sources",
      Bun.resolveSync("@lando/engine/services/config", import.meta.dir),
    )
  );
  const acquisition = spyOn(acquisitionModule, "readGlobalConfigSources");
  try {
    const layer = makeLandoRuntime({
      bootstrap: "app",
      config: { userConfRoot: root, userDataRoot: join(root, "data"), userCacheRoot: join(root, "cache") },
      configSources: { env: false },
    });
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer);
          const service = Context.get(context, ConfigService);
          const before = yield* service.load;
          yield* Effect.promise(() => writeFile(file, "router:\n  httpPort: 8124\n"));
          return { before, after: yield* service.load, port: yield* service.get("router") };
        }),
      ),
    );
    expect(acquisition).toHaveBeenCalledTimes(1);
    expect(values.before.router?.httpPort).toBe(8123);
    expect(values.after).toBe(values.before);
    expect(values.port?.httpPort).toBe(8123);
  } finally {
    acquisition.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("two runtimes keep independent host configs and roots in one process", async () => {
  const runtimes = [8123, 8124].map((port) =>
    makeLandoRuntime({
      bootstrap: "minimal",
      configSources: { user: false, env: false },
      config: { router: { httpPort: port }, userDataRoot: `/tmp/lando-snapshot-${port}` },
    }),
  );
  const values = await Promise.all(
    runtimes.map((layer) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return { config: yield* (yield* ConfigService).load, paths: yield* PathsService };
        }).pipe(Effect.provide(layer)),
      ),
    ),
  );
  expect(values.map((value) => value.config.router?.httpPort)).toEqual([8123, 8124]);
  expect(values.map((value) => value.paths.roots.userDataRoot)).toEqual([
    "/tmp/lando-snapshot-8123",
    "/tmp/lando-snapshot-8124",
  ]);
});

test("doctor passes its validated snapshot to provider bootstrap without reacquisition", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-snapshot-"));
  const acquisitionModule: typeof import("@lando/paths/config-sources") = await import(
    Bun.resolveSync(
      "@lando/paths/config-sources",
      Bun.resolveSync("@lando/engine/services/config", import.meta.dir),
    )
  );
  const acquisition = spyOn(acquisitionModule, "readGlobalConfigSources");
  try {
    const report = await Effect.runPromise(
      resilientDoctorReport({ env: { LANDO_DOCTOR_SECTION_BUDGET_MS: "1000" } }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "none",
            configSources: { user: false, env: false },
            config: {
              userConfRoot: root,
              userDataRoot: join(root, "data"),
              userCacheRoot: join(root, "cache"),
            },
          }),
        ),
      ),
    );
    expect(report.globalConfig?.status).toBe("pass");
    expect(acquisition).toHaveBeenCalledTimes(1);
  } finally {
    acquisition.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
