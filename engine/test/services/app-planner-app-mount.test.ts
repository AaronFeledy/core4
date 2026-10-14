import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  LandofileShape,
  type ServiceConfig,
  ServiceName,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const APP_ROOT = process.cwd();
const planExit = (service: typeof ServiceConfig.Encoded) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "mount-test",
    runtime: 4,
    services: { web: { home: false, ...service } },
  });
  return Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(rememberLandofileAppRoot(landofile, APP_ROOT), TestRuntimeProvider.capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(PluginRegistryLayer.layer)),
  );
};

test("an authored apache mount replaces app-source intent at an equivalent destination", async () => {
  // Given a moved app mount and a differently spelled authored mount at that destination.
  const service = { type: "apache", appMount: { target: "/site" }, mounts: ["./alternate:/site/./"] };
  // When
  const exit = await planExit(service);
  // Then only the authored bind remains, with active mount-derived defaults.
  expect(Exit.isSuccess(exit)).toBe(true);
  if (!Exit.isSuccess(exit)) throw new Error("Expected planning success");
  const web = exit.value.services[ServiceName.make("web")];
  expect(web?.appMount).toBeUndefined();
  expect(web?.mounts).toMatchObject([{ type: "bind", source: `${APP_ROOT}/alternate`, target: "/site" }]);
  expect(web?.environment).toMatchObject({ LANDO_APP_ROOT: "/site", LANDO_PROJECT_MOUNT: "/site" });
  expect(String(web?.workingDirectory)).toBe("/site");
});

test.each(["relative", "/", "/app/.."])(
  'invalid authored appMount target "%s" retains its issue path',
  async (target) => {
    // Given
    const service = { type: "apache", appMount: { target } };
    // When
    const exit = await planExit(service);
    // Then validation fails at the authored field before feature finalization can mask it.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected planning failure");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(LandofileValidationError);
    if (!(error instanceof LandofileValidationError)) throw new Error("Expected landofile validation error");
    expect(error.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
      "services.web.appMount.target",
    ]);
  },
);

test("a moved tomcat appMount resolves its relative webroot", async () => {
  // Given
  const service = {
    type: "tomcat",
    certs: false,
    webroot: "target/myapp",
    appMount: { target: "/workspace" },
  };
  // When
  const exit = await planExit(service);
  // Then
  expect(Exit.isSuccess(exit)).toBe(true);
  if (!Exit.isSuccess(exit)) throw new Error("Expected planning success");
  const web = exit.value.services[ServiceName.make("web")];
  expect(String(web?.appMount?.target)).toBe("/workspace");
  expect(web?.environment.LANDO_WEBROOT).toBe("/workspace/target/myapp");
  expect(String(web?.workingDirectory)).toBe("/workspace");
});

for (const type of ["php:8.3", "nginx", "apache", "static:nginx", "tomcat"]) {
  test.each([undefined, "public"])(
    `${type} with appMount false rejects webroot %s at planning`,
    async (webroot) => {
      // Given: a web service without app code but with an app-relative root.
      const service = { type, appMount: false as const, ...(webroot === undefined ? {} : { webroot }) };
      // When: the complete app is planned.
      const exit = await planExit(service);
      // Then: the service-type rejection becomes a Landofile validation error.
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("Expected planning failure");
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(LandofileValidationError);
      expect(error?.message).toContain("is relative to the app mount, but appMount is false");
    },
  );
}
