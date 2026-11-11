import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ToolingExecError } from "@lando/sdk/errors";
import { AbsolutePath, LandofileShape, ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Layer, Option, Schema } from "effect";

import { buildLogsApp } from "../../src/operations/logs-build.ts";
import {
  markBuildResultUsed,
  openAppBuildResults,
  recordBuildResult,
} from "../../src/services/build-results.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { currentTestPlan } from "../current-plan.ts";
import { planWith, providerId } from "../services/build-app-runner-test-support.ts";

const withTempRoots = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-logs-build-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const makeLayer = (plan: ReturnType<typeof planWith>, userDataRoot: string, state: StateStoreShape) =>
  Layer.mergeAll(
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalTestLandofile(
            Schema.decodeUnknownSync(LandofileShape)({ name: "logs-build", services: {} }),
            plan.root,
          ),
        ),
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(plan)) })),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
        select: () => Effect.die(new TypeError("build logs must not select a provider")),
      }),
    ),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        env: {},
        platform: "linux",
        userDataRoot,
        userCacheRoot: join(userDataRoot, "cache"),
        userConfRoot: join(userDataRoot, "conf"),
        systemPluginRoot: join(userDataRoot, "plugins"),
      }),
    ),
    Layer.succeed(StateStore, state),
  );

const transcriptPath = (userDataRoot: string, planId: string, phase: string, name: string) =>
  AbsolutePath.make(join(userDataRoot, "builds", planId, phase, "web", `${name}.log`));

const seed = async (
  state: StateStoreShape,
  plan: ReturnType<typeof planWith>,
  inputs: ReadonlyArray<{
    readonly name: string;
    readonly phase: "artifact" | "app";
    readonly step?: string;
    readonly body?: string;
  }>,
  userDataRoot: string,
) => {
  const bucket = await Effect.runPromise(openAppBuildResults(state, String(plan.id)));
  for (const input of inputs) {
    const path = transcriptPath(userDataRoot, String(plan.id), input.phase, input.name);
    if (input.body !== undefined) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, input.body);
    }
    await Effect.runPromise(
      recordBuildResult(bucket, {
        buildKey: input.name,
        service: ServiceName.make("web"),
        phase: input.phase,
        ...(input.step === undefined ? {} : { step: input.step }),
        outcome: "complete",
        exitCode: 0,
        durationMs: 1,
        transcriptPath: path,
      }),
    );
  }
  return bucket;
};

describe("buildLogsApp", () => {
  test("prints the latest recorded output for each current step in plan order", async () => {
    await withTempRoots(async (root) => {
      // Given image output, app-step output, a superseded attempt, and a step no longer planned.
      const plan = planWith({
        web: [
          { id: "install", phase: "app", command: { command: ["install"] } },
          { id: "migrate", phase: "app", command: { command: ["migrate"] } },
        ],
      });
      const state = makeTestStateStore();
      await seed(
        state.service,
        plan,
        [
          { name: "image", phase: "artifact", body: "image output\n" },
          { name: "old-install", phase: "app", step: "web:app:install", body: "old output\n" },
          { name: "install", phase: "app", step: "web:app:install", body: "install output\n" },
          { name: "removed", phase: "app", step: "web:app:removed", body: "removed output\n" },
        ],
        root,
      );

      // When
      const result = await Effect.runPromise(
        buildLogsApp().pipe(Effect.provide(makeLayer(plan, root, state.service))),
      );

      // Then only the latest attempt of a step still in the plan is printed.
      expect(result.build).toBe(true);
      expect(result.lines).toEqual([
        { service: "web", stream: "stdout", line: "image output", source: "build" },
        {
          service: "web",
          stream: "stdout",
          line: "install output",
          source: "build:web:app:install",
        },
      ]);
    });
  });

  test("reads only the requested tail from the selected service", async () => {
    await withTempRoots(async (root) => {
      const plan = planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      });
      const state = makeTestStateStore();
      await seed(
        state.service,
        plan,
        [{ name: "image", phase: "artifact", body: "one\ntwo\nthree\n" }],
        root,
      );

      // When
      const result = await Effect.runPromise(
        buildLogsApp({ service: "web", tail: 1 }).pipe(Effect.provide(makeLayer(plan, root, state.service))),
      );

      // Then
      expect(result.lines).toEqual([{ service: "web", stream: "stdout", line: "three", source: "build" }]);
    });
  });

  test("rejects an unknown --service the way logsApp does, without selecting a provider", async () => {
    await withTempRoots(async (root) => {
      const plan = planWith({
        web: [{ id: "install", phase: "app", command: { command: ["install"] } }],
      });
      const state = makeTestStateStore();

      // When
      const exit = await Effect.runPromiseExit(
        buildLogsApp({ service: "database" }).pipe(Effect.provide(makeLayer(plan, root, state.service))),
      );

      // Then
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(ToolingExecError);
      if (!(error instanceof ToolingExecError)) return;
      expect(error.message).toContain("database");
      expect(error.remediation).toBe("Example: lando logs --service web");
    });
  });

  test("returns an empty build result for an app that never built", async () => {
    await withTempRoots(async (root) => {
      const plan = planWith({});
      const state = makeTestStateStore();

      // When
      const result = await Effect.runPromise(
        buildLogsApp().pipe(Effect.provide(makeLayer(plan, root, state.service))),
      );

      // Then
      expect(result).toEqual({ app: plan.name, lines: [], build: true });
    });
  });

  test("prints the key marked in use, not the last recorded one", async () => {
    await withTempRoots(async (root) => {
      // Given two keys where the older one is the key the app is running.
      const plan = planWith({ web: [] });
      const state = makeTestStateStore();
      const bucket = await seed(
        state.service,
        plan,
        [
          { name: "six", phase: "artifact", body: "version 6\n" },
          { name: "seven", phase: "artifact", body: "version 7\n" },
        ],
        root,
      );
      const entries = (await Effect.runPromise(bucket.get)) ?? [];
      const used = entries.find((entry) => entry.buildKey === "six");
      if (used === undefined) throw new TypeError("older key is missing");
      await Effect.runPromise(markBuildResultUsed(bucket, used));

      // When
      const result = await Effect.runPromise(
        buildLogsApp().pipe(Effect.provide(makeLayer(plan, root, state.service))),
      );

      // Then the output that is actually in use is printed.
      expect(result.lines).toEqual([
        { service: "web", stream: "stdout", line: "version 6", source: "build" },
      ]);
    });
  });
});
