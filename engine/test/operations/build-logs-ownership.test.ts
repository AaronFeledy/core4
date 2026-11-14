import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, BuildOrchestrator, LandofileService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema, Stream } from "effect";
import { buildLogsApp } from "../../src/operations/logs-build.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { currentTestPlan } from "../current-plan.ts";
import { makeLayer, planWith, withTempRoots } from "../services/build-app-runner-test-support.ts";

const readLogs = (plan: AppPlan) =>
  buildLogsApp().pipe(
    Effect.provideService(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(plan)) })),
    Effect.provideService(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(
          literalTestLandofile(
            Schema.decodeUnknownSync(LandofileShape)({ name: plan.name, services: {} }),
            plan.root,
          ),
        ),
      }),
    ),
  );

test("#2291 never-started same-name root has no foreign build output; populated and renamed roots retain only their history", async () => {
  await withTempRoots(async () => {
    const base = planWith({ web: [{ id: "install", phase: "app", command: { command: ["install"] } }] });
    const data = process.env.LANDO_USER_DATA_ROOT;
    if (data === undefined) throw new TypeError("Missing test data root");
    const a = { ...base, root: AbsolutePath.make(join(data, "a")) };
    const b = { ...base, root: AbsolutePath.make(join(data, "b")) };
    await mkdir(a.root);
    await mkdir(b.root);
    let marker = "root A output";
    const provider = {
      ...TestRuntimeProvider,
      execStream: () =>
        Stream.make(
          { kind: "stdout" as const, chunk: new TextEncoder().encode(`${marker}\n`) },
          { exitCode: 0 },
        ),
    };

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const build = yield* BuildOrchestrator;
        yield* build.buildApp(a);
        const neverStarted = yield* readLogs(b);
        marker = "root B output";
        yield* build.buildApp(b);
        const populatedA = yield* readLogs(a);
        const populatedB = yield* readLogs(b);
        const renamed = yield* readLogs({
          ...a,
          id: AppId.make("renamed"),
          slug: "renamed",
          name: "renamed",
        });
        return { neverStarted, populatedA, populatedB, renamed };
      }).pipe(Effect.provide(makeLayer(provider))),
    );

    expect(result.neverStarted.lines).toEqual([]);
    expect(result.populatedA.lines.map((line) => line.line)).toEqual(["root A output"]);
    expect(result.populatedB.lines.map((line) => line.line)).toEqual(["root B output"]);
    expect(result.renamed.lines.map((line) => line.line)).toEqual(["root A output"]);
  });
});
