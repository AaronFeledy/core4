import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted, Schema } from "effect";

import {
  AppPlanner,
  DataMover,
  Dataset,
  InteractionService,
  LandofileService,
  RemoteSource,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import { TestDataset, TestRemoteSource, TestRuntimeProvider } from "@lando/core/testing";
import { type SyncResult, SyncResult as SyncResultSchema } from "@lando/sdk/schema";
import type { DataMoverShape, InteractionServiceShape, RemoteSourceShape } from "@lando/sdk/services";

type RemoteConfigInput = { readonly source: string } & Readonly<Record<string, unknown>>;

interface RemoteOperations {
  readonly appPull: (options: {
    readonly cwd?: string;
    readonly remote?: string;
    readonly env?: string;
    readonly only?: ReadonlyArray<string>;
    readonly yes?: boolean;
    readonly noSnapshot?: boolean;
  }) => Effect.Effect<unknown, unknown>;
  readonly appPush: (options: {
    readonly cwd?: string;
    readonly remote?: string;
    readonly env?: string;
    readonly only?: ReadonlyArray<string>;
    readonly force?: boolean;
    readonly yes?: boolean;
  }) => Effect.Effect<unknown, unknown>;
  readonly appRemoteAdd: (options: {
    readonly cwd?: string;
    readonly name: string;
    readonly config: RemoteConfigInput;
  }) => Effect.Effect<unknown, unknown>;
  readonly appRemoteList: (options?: { readonly cwd?: string; readonly remote?: string }) => Effect.Effect<
    ReadonlyArray<unknown>,
    unknown
  >;
  readonly appRemoteRemove: (options: { readonly cwd?: string; readonly name: string }) => Effect.Effect<
    unknown,
    unknown
  >;
  readonly appRemoteTest: (options?: {
    readonly cwd?: string;
    readonly remote?: string;
    readonly env?: string;
  }) => Effect.Effect<unknown, unknown>;
  readonly appRemote: {
    readonly list: RemoteOperations["appRemoteList"];
    readonly add: RemoteOperations["appRemoteAdd"];
    readonly test: RemoteOperations["appRemoteTest"];
    readonly env: { readonly list: unknown };
  };
}

const requireRemoteOperations = async (): Promise<RemoteOperations> => {
  const operations = (await import("@lando/core/cli/operations")) as Record<string, unknown>;
  expect(typeof operations.appPull, "appPull must be exported from @lando/core/cli/operations").toBe(
    "function",
  );
  expect(
    typeof operations.appRemoteAdd,
    "appRemoteAdd must be exported from @lando/core/cli/operations",
  ).toBe("function");
  expect(
    typeof operations.appRemoteList,
    "appRemoteList must be exported from @lando/core/cli/operations",
  ).toBe("function");
  expect(
    typeof operations.appRemoteRemove,
    "appRemoteRemove must be exported from @lando/core/cli/operations",
  ).toBe("function");
  expect(typeof operations.appPush, "appPush must be exported from @lando/core/cli/operations").toBe(
    "function",
  );
  expect(
    typeof operations.appRemoteTest,
    "appRemoteTest must be exported from @lando/core/cli/operations",
  ).toBe("function");
  const appRemote = operations.appRemote as { readonly [key: string]: unknown } | undefined;
  expect(typeof appRemote?.list, "appRemote.list must be exported").toBe("function");
  expect(typeof appRemote?.add, "appRemote.add must be exported").toBe("function");
  expect(typeof appRemote?.test, "appRemote.test must be exported").toBe("function");
  expect(typeof (appRemote?.env as { readonly list?: unknown } | undefined)?.list, "appRemote.env.list").toBe(
    "function",
  );
  return operations as unknown as RemoteOperations;
};

const withTempRemoteApp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-remote-sync-skeleton-")));
  try {
    await writeFile(
      join(dir, ".lando.yml"),
      "name: remote-skeleton\nruntime: 4\nservices:\n  web:\n    type: node\n",
    );
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const isCommandSpec = (
  value: unknown,
): value is {
  readonly id: string;
  readonly bootstrap: string;
  readonly flags?: unknown;
  readonly resultSchema?: unknown;
} =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  "bootstrap" in value &&
  typeof (value as { readonly id?: unknown }).id === "string";

describe("remote sync command skeleton", () => {
  test("registers app command specs with result schemas and remote flags", async () => {
    const modules = await Promise.all([
      import("../../src/cli/oclif/commands/app/pull.ts"),
      import("../../src/cli/oclif/commands/app/push.ts"),
      import("../../src/cli/oclif/commands/app/remote/list.ts"),
      import("../../src/cli/oclif/commands/app/remote/add.ts"),
      import("../../src/cli/oclif/commands/app/remote/remove.ts"),
      import("../../src/cli/oclif/commands/app/remote/test.ts"),
      import("../../src/cli/oclif/commands/app/remote/setup.ts"),
      import("../../src/cli/oclif/commands/app/remote/env/list.ts"),
    ]);

    const specs = modules.map((mod) => Object.values(mod).find((value) => isCommandSpec(value)));
    expect(specs, "every remote command module must export a LandoCommandSpec").not.toContain(undefined);
    for (const spec of specs) {
      expect(spec?.bootstrap).toBe("app");
      expect(spec?.resultSchema, `${spec?.id} must carry a resultSchema`).toBeDefined();
      expect(spec?.flags, `${spec?.id} must define remote skeleton flags`).toHaveProperty("format");
    }
  });

  test("remote selector parsing keeps --remote authoritative while honoring @env", async () => {
    const { remoteSyncOptionsFromInput } = await import("../../src/cli/oclif/commands/app/remote/common.ts");

    expect(remoteSyncOptionsFromInput({ flags: {}, args: { env: "stage@dev" } })).toMatchObject({
      remote: "stage",
      env: "dev",
    });
    expect(
      remoteSyncOptionsFromInput({ flags: { remote: "stage" }, args: { env: "other@prod" } }),
    ).toMatchObject({
      remote: "stage",
      env: "prod",
    });
  });

  test("compiled remote renderers forward RenderContext", async () => {
    const runSource = await Bun.file(join(import.meta.dir, "../../src/cli/run.ts")).text();
    const adapterSource = await Bun.file(
      join(import.meta.dir, "../../src/cli/cli-adapters/app-lifecycle.ts"),
    ).text();
    const remoteSource = await Bun.file(join(import.meta.dir, "../../src/cli/commands/remote.ts")).text();

    expect(adapterSource).toContain("renderSyncResult(value, compiledFormat(input), ctx)");
    expect(adapterSource).toContain("renderRemoteListResult(value, options.format, ctx)");
    expect(adapterSource).toContain('renderRemoteMutationResult(value, "added", options.format, ctx)');
    expect(adapterSource).toContain('renderRemoteMutationResult(value, "removed", options.format, ctx)');
    expect(adapterSource).toContain("renderRemoteTestResult(value, options.format, ctx)");
    expect(adapterSource).toContain("renderRemoteEnvListResult(value, options.format, ctx)");
    expect(runSource).toContain('argv[0] === "pull:app"');
    expect(runSource).toContain('argv[0] === "remote:list:app"');
    expect(runSource).toContain('argv[0] === "remote:list:env:app"');
    expect(remoteSource).not.toContain('ctx?.mode === "json"');
    expect(remoteSource).not.toContain('format === "json"');
  });

  test("remote add writes remotes and remote list reads them without a provider", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();

      await Effect.runPromise(
        operations.appRemoteAdd({
          cwd: dir,
          name: "stage",
          config: { source: "local", url: "https://example.test/site" },
        }),
      );
      await Effect.runPromise(
        operations.appRemoteAdd({
          cwd: dir,
          name: "prod",
          config: { source: "other", url: "https://example.test/prod" },
        }),
      );
      const remotes = await Effect.runPromise(operations.appRemoteList({ cwd: dir }));
      const filtered = await Effect.runPromise(operations.appRemoteList({ cwd: dir, remote: "stage" }));
      const text = await Bun.file(join(dir, ".lando.yml")).text();

      expect(text).toContain("remotes:");
      expect(text).toContain("stage:");
      expect(text).toContain("source: local");
      expect(JSON.stringify(remotes)).toContain("stage");
      expect(JSON.stringify(remotes)).toContain("prod");
      expect(JSON.stringify(remotes)).toContain("https://example.test/site");
      expect(JSON.stringify(filtered)).toContain("stage");
      expect(JSON.stringify(filtered)).not.toContain("prod");
    });
  });

  test("remote remove reports a missing Landofile remote without plugin remediation", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();

      const exit = await Effect.runPromiseExit(operations.appRemoteRemove({ cwd: dir, name: "stage" }));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const error = JSON.stringify(exit.cause.toJSON());
        expect(error).toContain("RemoteError");
        expect(error).toContain("Remote stage is not configured");
        expect(error).not.toContain("RemoteProviderUnavailableError");
        expect(error).not.toContain("plugin:add");
      }
    });
  });

  test("remote command results redact secret-bearing config fields", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();

      const added = await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "stage", config: TestRemoteSource.config }),
      );
      const remotes = await Effect.runPromise(operations.appRemoteList({ cwd: dir }));
      const text = await Bun.file(join(dir, ".lando.yml")).text();

      expect(JSON.stringify(added)).toContain("[redacted]");
      expect(JSON.stringify(remotes)).toContain("[redacted]");
      expect(text).toContain("token:");
      expect(text).not.toContain("[redacted]");
    });
  });

  test("remote selection can use the sole installed RemoteSource without a Landofile remote", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();
      const result = await Effect.runPromise(
        operations
          .appRemoteTest({ cwd: dir, remote: "test", env: TestRemoteSource.supportedEnv })
          .pipe(Effect.provide(Layer.succeed(RemoteSource, TestRemoteSource.source))) as Effect.Effect<
          { readonly ok: boolean; readonly env?: string },
          unknown,
          never
        >,
      );

      expect(result.ok).toBe(true);
      expect(result.env).toBe(TestRemoteSource.supportedEnv);
    });
  });

  test("pull uses RemoteSource, Dataset, confirmation, and safety snapshot when installed", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );

      const snapshots: string[] = [];
      const dataMover: DataMoverShape = {
        transfer: () => Effect.die("external transfer is not used by the orchestration skeleton"),
        transferStream: () =>
          Effect.die("external transfer stream is not used by the orchestration skeleton"),
        snapshot: (store) =>
          Effect.sync(() => {
            snapshots.push(store.store);
            return { id: "cli-remote-snapshot", store };
          }),
        restore: () => Effect.void,
        listSnapshots: () => Effect.succeed([]),
        removeSnapshot: () => Effect.void,
        pruneSnapshots: () => Effect.succeed([]),
      };
      let confirms = 0;
      const interaction: InteractionServiceShape = {
        id: "remote-test-interaction",
        isInteractive: Effect.succeed(true),
        prompt: () => Effect.die("prompt must not run"),
        promptAll: () => Effect.die("promptAll must not run"),
        confirm: () =>
          Effect.sync(() => {
            confirms += 1;
            return true;
          }),
        select: () => Effect.die("select must not run"),
        secret: () => Effect.succeed(Redacted.make("secret")),
      };
      const plan = TestDataset.context.plan;

      const pullProgram = operations
        .appPull(
          { cwd: dir, remote: "test", env: TestRemoteSource.supportedEnv, only: [TestDataset.dataset.kind] },
          { plan, root: dir, app: { kind: "user", id: plan.id, root: plan.root } },
        )
        .pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RemoteSource, TestRemoteSource.source),
              Layer.succeed(Dataset, TestDataset.dataset),
              Layer.succeed(DataMover, dataMover),
              Layer.succeed(InteractionService, interaction),
              Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
              Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
              Layer.succeed(RuntimeProviderRegistry, {
                list: Effect.succeed([]),
                capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                select: () => Effect.die("target supplies the plan"),
              }),
            ),
          ),
        ) as Effect.Effect<unknown, unknown, never>;
      const result = (await Effect.runPromise(pullProgram)) as {
        readonly direction: string;
        readonly snapshots?: ReadonlyArray<{ readonly id: string }>;
      };
      const delegations = await Effect.runPromise(TestRemoteSource.observations.datasetDelegations());
      const transfers = await Effect.runPromise(TestDataset.observations.dataMoverTransfers());

      expect(result.direction).toBe("pull");
      expect(result.snapshots?.map((snapshot) => snapshot.id)).toEqual(["cli-remote-snapshot"]);
      expect(snapshots).toEqual(["database"]);
      expect(confirms).toBe(1);
      expect(delegations.map((entry) => entry.operation)).toContain("fetch");
      expect(transfers.map((entry) => entry.operation)).toContain("apply");
    });
  });

  test("pull uses the remote default environment and deduplicates selected datasets", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "default-env", config: { source: "default-env" } }),
      );
      const plan = TestDataset.context.plan;
      const target = { plan, root: dir, app: { kind: "user" as const, id: plan.id, root: plan.root } };
      let fetches = 0;
      const defaultEnvSource: RemoteSourceShape = {
        ...TestRemoteSource.source,
        id: "default-env",
        listEnvironments: () =>
          Effect.succeed([{ id: "stage", label: "Stage", default: true, datasets: ["database" as const] }]),
        resolve: (_config: RemoteConfigInput, env: string, dataset: string) => {
          if (dataset !== "database") return Effect.die("unexpected dataset");
          return Effect.succeed({
            remote: "default-env",
            env,
            dataset: "database" as const,
            endpoint: `memory://default-env/${env}`,
          });
        },
        fetch: () =>
          Effect.sync(() => {
            fetches += 1;
            return TestRemoteSource.artifact;
          }),
      };

      const result = (await Effect.runPromise(
        operations
          .appPull({ cwd: dir, remote: "default-env", only: ["database", "database"], yes: true }, target)
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RemoteSource, defaultEnvSource),
                Layer.succeed(Dataset, TestDataset.dataset),
                Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
                Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
                Layer.succeed(RuntimeProviderRegistry, {
                  list: Effect.succeed([]),
                  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                  select: () => Effect.die("target supplies the plan"),
                }),
              ),
            ),
          ) as Effect.Effect<unknown, unknown, never>,
      )) as SyncResult;

      expect(result.env).toBe("stage");
      expect(result.datasets).toEqual(["database"]);
      expect(fetches).toBe(1);
    });
  });

  test("pull fails with RemoteProviderUnavailableError when no RemoteSource is installed", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "stage", config: { source: "local" } }),
      );

      const exit = await Effect.runPromiseExit(
        operations.appPull({ cwd: dir, remote: "stage", env: "dev", only: ["database"], yes: true }),
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause.toJSON())).toContain("RemoteProviderUnavailableError");
      }
    });
  });

  test("pull and push report missing Dataset as a dataset error", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );
      const plan = TestDataset.context.plan;
      const target = { plan, root: dir, app: { kind: "user" as const, id: plan.id, root: plan.root } };
      const layer = Layer.mergeAll(
        Layer.succeed(RemoteSource, TestRemoteSource.source),
        Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("target supplies the plan"),
        }),
      );

      const pullExit = await Effect.runPromiseExit(
        operations
          .appPull({ cwd: dir, remote: "test", env: "dev", only: ["database"], yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );
      const pushExit = await Effect.runPromiseExit(
        operations
          .appPush({ cwd: dir, remote: "test", env: "dev", only: ["database"], yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );

      expect(pullExit._tag).toBe("Failure");
      expect(pushExit._tag).toBe("Failure");
      if (pullExit._tag === "Failure") {
        const error = JSON.stringify(pullExit.cause.toJSON());
        expect(error).toContain("RemoteDatasetUnsupportedError");
        expect(error).not.toContain("RemoteProviderUnavailableError");
      }
      if (pushExit._tag === "Failure") {
        const error = JSON.stringify(pushExit.cause.toJSON());
        expect(error).toContain("RemoteDatasetUnsupportedError");
        expect(error).not.toContain("RemoteProviderUnavailableError");
      }
    });
  });

  test("pull and push reject invalid or empty dataset selections", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );
      const plan = TestDataset.context.plan;
      const target = { plan, root: dir, app: { kind: "user" as const, id: plan.id, root: plan.root } };
      const layer = Layer.mergeAll(
        Layer.succeed(RemoteSource, TestRemoteSource.source),
        Layer.succeed(Dataset, TestDataset.dataset),
        Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("target supplies the plan"),
        }),
      );

      const invalidPull = await Effect.runPromiseExit(
        operations
          .appPull({ cwd: dir, remote: "test", env: "dev", only: ["bogus"], yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );
      const emptyPush = await Effect.runPromiseExit(
        operations
          .appPush({ cwd: dir, remote: "test", env: "dev", only: [], yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );

      expect(invalidPull._tag).toBe("Failure");
      expect(emptyPush._tag).toBe("Failure");
      if (invalidPull._tag === "Failure") {
        expect(JSON.stringify(invalidPull.cause.toJSON())).toContain("Unsupported dataset kind bogus");
      }
      if (emptyPush._tag === "Failure") {
        expect(JSON.stringify(emptyPush.cause.toJSON())).toContain("No dataset kinds were selected");
      }
    });
  });

  test("default multi-kind sync fails before partial transfer when a Dataset is missing", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "multi", config: { source: "multi" } }),
      );
      const plan = TestDataset.context.plan;
      const target = { plan, root: dir, app: { kind: "user" as const, id: plan.id, root: plan.root } };
      let fetches = 0;
      let sends = 0;
      const multiKindSource = {
        ...TestRemoteSource.source,
        id: "multi",
        capabilities: { ...TestRemoteSource.source.capabilities, datasets: ["database", "files"] as const },
        fetch: () =>
          Effect.sync(() => {
            fetches += 1;
            return TestRemoteSource.artifact;
          }),
        send: () =>
          Effect.sync(() => {
            sends += 1;
          }),
      };
      const layer = Layer.mergeAll(
        Layer.succeed(RemoteSource, multiKindSource),
        Layer.succeed(Dataset, TestDataset.dataset),
        Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("target supplies the plan"),
        }),
      );

      const pullExit = await Effect.runPromiseExit(
        operations
          .appPull({ cwd: dir, remote: "multi", env: "dev", yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );
      const pushExit = await Effect.runPromiseExit(
        operations
          .appPush({ cwd: dir, remote: "multi", env: "dev", yes: true }, target)
          .pipe(Effect.provide(layer)) as Effect.Effect<unknown, unknown, never>,
      );

      expect(pullExit._tag).toBe("Failure");
      expect(pushExit._tag).toBe("Failure");
      expect(fetches).toBe(0);
      expect(sends).toBe(0);
      if (pullExit._tag === "Failure") {
        expect(JSON.stringify(pullExit.cause.toJSON())).toContain(
          "No Dataset is installed for dataset kind files",
        );
      }
      if (pushExit._tag === "Failure") {
        expect(JSON.stringify(pushExit.cause.toJSON())).toContain(
          "No Dataset is installed for dataset kind files",
        );
      }
    });
  });

  test("pull fails closed when confirmation is required but no InteractionService is available", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );
      const plan = TestDataset.context.plan;

      const exit = await Effect.runPromiseExit(
        operations
          .appPull(
            {
              cwd: dir,
              remote: "test",
              env: TestRemoteSource.supportedEnv,
              only: [TestDataset.dataset.kind],
            },
            { plan, root: dir, app: { kind: "user", id: plan.id, root: plan.root } },
          )
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RemoteSource, TestRemoteSource.source),
                Layer.succeed(Dataset, TestDataset.dataset),
                Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
                Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
                Layer.succeed(RuntimeProviderRegistry, {
                  list: Effect.succeed([]),
                  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                  select: () => Effect.die("target supplies the plan"),
                }),
              ),
            ),
          ) as Effect.Effect<unknown, unknown, never>,
      );

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause.toJSON())).toContain("RemoteProtectedEnvError");
      }
    });
  });

  test("push and remote test fail with RemoteProviderUnavailableError when no RemoteSource is installed", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await requireRemoteOperations();
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "stage", config: { source: "local" } }),
      );

      const pushExit = await Effect.runPromiseExit(
        operations.appPush({ cwd: dir, remote: "stage", env: "dev", only: ["database"], yes: true }),
      );
      const testExit = await Effect.runPromiseExit(operations.appRemoteTest({ cwd: dir, remote: "stage" }));

      expect(pushExit._tag).toBe("Failure");
      expect(testExit._tag).toBe("Failure");
      if (pushExit._tag === "Failure") {
        expect(JSON.stringify(pushExit.cause.toJSON())).toContain("RemoteProviderUnavailableError");
      }
      if (testExit._tag === "Failure") {
        expect(JSON.stringify(testExit.cause.toJSON())).toContain("RemoteProviderUnavailableError");
      }
    });
  });

  test("push enforces source capabilities and protected environments", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "no-push", config: { source: "test-no-push" } }),
      );
      const plan = TestDataset.context.plan;
      const baseLayer = Layer.mergeAll(
        Layer.succeed(Dataset, TestDataset.dataset),
        Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
        Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
        Layer.succeed(RuntimeProviderRegistry, {
          list: Effect.succeed([]),
          capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
          select: () => Effect.die("target supplies the plan"),
        }),
      );
      const target = { plan, root: dir, app: { kind: "user" as const, id: plan.id, root: plan.root } };

      const noPushExit = await Effect.runPromiseExit(
        operations
          .appPush(
            { cwd: dir, remote: "no-push", env: "dev", only: [TestDataset.dataset.kind], yes: true },
            target,
          )
          .pipe(
            Effect.provide(
              Layer.merge(baseLayer, Layer.succeed(RemoteSource, TestRemoteSource.noPushSource)),
            ),
          ) as Effect.Effect<unknown, unknown, never>,
      );
      const protectedExit = await Effect.runPromiseExit(
        operations
          .appPush(
            {
              cwd: dir,
              remote: "test",
              env: TestRemoteSource.protectedEnv,
              only: [TestDataset.dataset.kind],
              yes: true,
            },
            target,
          )
          .pipe(
            Effect.provide(Layer.merge(baseLayer, Layer.succeed(RemoteSource, TestRemoteSource.source))),
          ) as Effect.Effect<unknown, unknown, never>,
      );
      const forced = (await Effect.runPromise(
        operations
          .appPush(
            {
              cwd: dir,
              remote: "test",
              env: TestRemoteSource.protectedEnv,
              only: [TestDataset.dataset.kind],
              force: true,
              yes: true,
            },
            target,
          )
          .pipe(
            Effect.provide(Layer.merge(baseLayer, Layer.succeed(RemoteSource, TestRemoteSource.source))),
          ) as Effect.Effect<unknown, unknown, never>,
      )) as { readonly direction: string; readonly env: string };

      expect(noPushExit._tag).toBe("Failure");
      expect(protectedExit._tag).toBe("Failure");
      if (noPushExit._tag === "Failure") {
        expect(JSON.stringify(noPushExit.cause.toJSON())).toContain("RemoteDatasetUnsupportedError");
      }
      if (protectedExit._tag === "Failure") {
        expect(JSON.stringify(protectedExit.cause.toJSON())).toContain("RemoteProtectedEnvError");
      }
      expect(forced.direction).toBe("push");
      expect(forced.env).toBe(TestRemoteSource.protectedEnv);
    });
  });

  test("pull honors no-snapshot and renderer json mode", async () => {
    await withTempRemoteApp(async (dir) => {
      const operations = await import("@lando/core/cli/operations");
      await Effect.runPromise(
        operations.appRemoteAdd({ cwd: dir, name: "test", config: TestRemoteSource.config }),
      );
      let snapshotCalls = 0;
      const dataMover: DataMoverShape = {
        transfer: () => Effect.die("external transfer is not used by the orchestration skeleton"),
        transferStream: () =>
          Effect.die("external transfer stream is not used by the orchestration skeleton"),
        snapshot: () =>
          Effect.sync(() => {
            snapshotCalls += 1;
            return { id: "unexpected", store: { app: TestDataset.context.plan.id, store: "database" } };
          }),
        restore: () => Effect.void,
        listSnapshots: () => Effect.succeed([]),
        removeSnapshot: () => Effect.void,
        pruneSnapshots: () => Effect.succeed([]),
      };
      const plan = TestDataset.context.plan;
      const result = (await Effect.runPromise(
        operations
          .appPull(
            {
              cwd: dir,
              remote: "test",
              env: TestRemoteSource.supportedEnv,
              only: [TestDataset.dataset.kind],
              noSnapshot: true,
              yes: true,
            },
            { plan, root: dir, app: { kind: "user", id: plan.id, root: plan.root } },
          )
          .pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(RemoteSource, TestRemoteSource.source),
                Layer.succeed(Dataset, TestDataset.dataset),
                Layer.succeed(DataMover, dataMover),
                Layer.succeed(LandofileService, { discover: Effect.die("target supplies the landofile") }),
                Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
                Layer.succeed(RuntimeProviderRegistry, {
                  list: Effect.succeed([]),
                  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
                  select: () => Effect.die("target supplies the plan"),
                }),
              ),
            ),
          ) as Effect.Effect<unknown, unknown, never>,
      )) as SyncResult;

      expect(snapshotCalls).toBe(0);
      expect(result.snapshots).toEqual([]);
      expect(Schema.decodeUnknownSync(SyncResultSchema)(Schema.encodeSync(SyncResultSchema)(result))).toEqual(
        result,
      );
    });
  });
});
