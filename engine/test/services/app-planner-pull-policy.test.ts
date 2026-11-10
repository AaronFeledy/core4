import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import {
  LandofileShape,
  type ProviderCapabilities,
  ServiceName,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestFileSyncEngine, TestRuntimeProvider } from "@lando/sdk/test";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { GlobalConfigSources } from "../../src/services/config.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { planLiteralTestLandofile } from "../compiled-landofile.ts";
import { fileSyncEngineLayer } from "../file-sync-engine.ts";

const pullingCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  artifactBuild: true,
  artifactPull: true,
};

const planExit = (service: Record<string, unknown>) =>
  Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) =>
      planLiteralTestLandofile(
        planner,
        Schema.decodeUnknownSync(LandofileShape)({
          name: "pullpolicy",
          runtime: 4,
          services: { web: { home: false, ...service } },
        }),
        pullingCapabilities,
      ),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provide(
        Layer.mergeAll(
          PluginRegistryLayer.layer,
          fileSyncEngineLayer({ ...TestFileSyncEngine, id: "mutagen" }),
        ),
      ),
      Effect.provideService(GlobalConfigSources, { env: {}, sources: { user: false, env: true } }),
    ),
  );

const inTempApp = async <T>(run: () => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-pull-policy-")));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    return await run();
  } finally {
    process.chdir(previous);
    await rm(dir, { recursive: true, force: true });
  }
};

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const plannedPolicy = async (service: Record<string, unknown>) => {
  const exit = await planExit(service);
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value.services[ServiceName.make("web")];
};

describe("pull_policy planning", () => {
  test.each([
    ["missing", undefined],
    ["if_not_present", undefined],
    ["always", "always"],
    ["never", "never"],
  ] as const)(
    "Given pull_policy %s on an image service, when planned, then the plan carries %s",
    async (authored, expected) =>
      inTempApp(async () => {
        // When
        const service = await plannedPolicy({ type: "lando", image: "alpine:3", pull_policy: authored });

        // Then
        expect(service?.pullPolicy).toBe(expected);
        expect(service?.extensions.compose).not.toHaveProperty("pull_policy");
      }),
  );

  test("Given pull_policy build with a Compose build, when planned, then the build artifact carries the build policy", async () =>
    inTempApp(async () => {
      // When
      const service = await plannedPolicy({ type: "lando", build: { context: "." }, pull_policy: "build" });

      // Then
      expect(service?.artifact?.kind).toBe("build");
      expect(service?.pullPolicy).toBe("build");
    }));

  test.each([
    [{ type: "lando", image: "alpine:3", pull_policy: "daily" }, "always"],
    [{ type: "lando", image: "alpine:3", pull_policy: "every_12h" }, "always"],
    [{ type: "lando", image: "alpine:3", pull_policy: "refresh" }, "always"],
    [{ type: "lando", build: { context: "." }, pull_policy: "always" }, "pull_policy: build"],
    [{ type: "lando", build: { context: "." }, pull_policy: "never" }, "pull_policy: build"],
    [{ type: "lando", image: "alpine:3", pull_policy: "build" }, "build:"],
  ])(
    "Given unsupported pull_policy %j, when planned, then planning fails at the pull_policy path",
    async (service, advice) =>
      inTempApp(async () => {
        // When
        const failure = failureOf(await planExit(service));

        // Then
        expect(failure).toBeInstanceOf(LandofileValidationError);
        if (!(failure instanceof LandofileValidationError)) return;
        expect(failure.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
          "services.web.pull_policy",
        ]);
        expect(failure.issues[0]?.suggestion).toContain(advice);
      }),
  );
});
