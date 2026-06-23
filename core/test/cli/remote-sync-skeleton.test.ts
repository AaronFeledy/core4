import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Layer, Redacted } from "effect";

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
import type { DataMoverShape, InteractionServiceShape } from "@lando/sdk/services";

type RemoteConfigInput = { readonly source: string } & Readonly<Record<string, unknown>>;

interface RemoteOperations {
  readonly appPull: (options: {
    readonly cwd?: string;
    readonly remote?: string;
    readonly env?: string;
    readonly only?: ReadonlyArray<string>;
    readonly yes?: boolean;
  }) => Effect.Effect<unknown, unknown>;
  readonly appRemoteAdd: (options: {
    readonly cwd?: string;
    readonly name: string;
    readonly config: RemoteConfigInput;
  }) => Effect.Effect<unknown, unknown>;
  readonly appRemoteList: (options?: { readonly cwd?: string }) => Effect.Effect<
    ReadonlyArray<unknown>,
    unknown
  >;
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
      const remotes = await Effect.runPromise(operations.appRemoteList({ cwd: dir }));
      const text = await Bun.file(join(dir, ".lando.yml")).text();

      expect(text).toContain("remotes:");
      expect(text).toContain("stage:");
      expect(text).toContain("source: local");
      expect(JSON.stringify(remotes)).toContain("stage");
      expect(JSON.stringify(remotes)).toContain("https://example.test/site");
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
});
