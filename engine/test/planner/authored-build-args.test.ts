import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { BuildArgSecretReferenceError } from "@lando/sdk/errors";
import { LandofileShape, type ServiceConfig } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const APP_ROOT = process.cwd();
const planExit = (service: typeof ServiceConfig.Encoded) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "build-arg-secret",
    runtime: 4,
    services: { web: { home: false, ...service } },
  });
  return Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(rememberLandofileAppRoot(landofile, APP_ROOT), TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(PluginRegistryLayer.layer)),
  );
};

describe("authored compose build args", () => {
  test("plans a compose build whose args have no secret references", async () => {
    const exit = await planExit({
      type: "lando",
      build: { context: ".", args: { NODE_ENV: "production" } },
    });

    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) throw new Error("Expected planning success");
  });

  test("rejects an exact ${secret:...} in build.args before the build runs", async () => {
    const exit = await planExit({
      type: "lando",
      build: { context: ".", args: { TOKEN: "${secret:TOKEN}" } },
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected planning failure");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(BuildArgSecretReferenceError);
    expect(error).toMatchObject({
      _tag: "BuildArgSecretReferenceError",
      service: "web",
      arg: "TOKEN",
      reference: "${secret:TOKEN}",
    });
    if (error instanceof BuildArgSecretReferenceError) {
      expect(error.remediation).toContain("environment");
      expect(error.message).toContain("image history");
    }
  });

  test("rejects an embedded ${secret:...} in build.args", async () => {
    const exit = await planExit({
      type: "lando",
      build: { context: ".", args: { TOKEN: "prefix-${secret:TOKEN}" } },
    });

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected planning failure");
    expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
      _tag: "BuildArgSecretReferenceError",
      reference: "${secret:TOKEN}",
    });
  });
});
