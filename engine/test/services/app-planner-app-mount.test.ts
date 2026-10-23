import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Option, Schema } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { mergeLandofiles } from "@lando/sdk/landofile";
import {
  LandofileShape,
  type ServiceConfig,
  ServiceName,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { literalTestLandofile } from "../compiled-landofile.ts";

import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const APP_ROOT = process.cwd();
const planExit = (service: typeof ServiceConfig.Encoded, capabilities = TestRuntimeProvider.capabilities) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "mount-test",
    runtime: 4,
    services: { web: { home: false, ...service } },
  });
  return Effect.runPromiseExit(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalTestLandofile(landofile, APP_ROOT), capabilities),
    ).pipe(Effect.provide(AppPlannerLayer.layer), Effect.provide(PluginRegistryLayer.layer)),
  );
};

test.each([
  {
    healthcheck: false,
    expected: { kind: "none", intervalSeconds: 10, timeoutSeconds: 5, retries: 5 },
  },
  {
    healthcheck: "curl -f localhost",
    expected: {
      kind: "command",
      command: "curl -f localhost",
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 60,
    },
  },
])(
  "mysql authored healthcheck shorthand overrides the type probe: $healthcheck",
  async ({ healthcheck, expected }) => {
    const exit = await planExit({ type: "mysql", healthcheck });
    if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
    expect(exit.value.services[ServiceName.make("web")]?.healthcheck).toEqual(expected);
  },
);

test.each([
  {
    type: "mysql",
    healthcheck: { kind: "command" },
    expectedCommand: [
      "sh",
      "-c",
      'mysqladmin ping -h 127.0.0.1 -P 3306 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent',
    ],
    intervalSeconds: 10,
  },
  {
    type: "mysql",
    healthcheck: { interval: "5s" },
    expectedCommand: [
      "sh",
      "-c",
      'mysqladmin ping -h 127.0.0.1 -P 3306 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" --silent',
    ],
    intervalSeconds: 5,
  },
  {
    type: "compose",
    image: "alpine:3.21",
    healthcheck: { kind: "command" },
    expectedCommand: undefined,
    intervalSeconds: undefined,
  },
])("a fresh object after a disabled layer does not resurrect old probes: %j", async (fixture) => {
  const layers = [
    { healthcheck: { command: "old" } },
    { healthcheck: false },
    { healthcheck: fixture.healthcheck },
  ].map((service) =>
    Schema.decodeUnknownSync(LandofileShape)({ name: "layered", services: { web: service } }),
  );
  const merged = Schema.decodeUnknownSync(LandofileShape)(mergeLandofiles(layers));
  const authoredHealthcheck = merged.services?.[ServiceName.make("web")]?.healthcheck;
  if (authoredHealthcheck === undefined) throw new Error("Expected merged healthcheck");
  const exit = await planExit({
    type: fixture.type,
    ...("image" in fixture ? { image: fixture.image } : {}),
    healthcheck: authoredHealthcheck,
  });
  if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
  const healthcheck = exit.value.services[ServiceName.make("web")]?.healthcheck;
  expect(healthcheck?.command).toEqual(fixture.expectedCommand);
  expect(healthcheck?.intervalSeconds).toBe(fixture.intervalSeconds);
});

test("appMount destination shorthand sets the mount and active defaults", async () => {
  const exit = await planExit({ type: "apache", appMount: "/site" });
  if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
  const web = exit.value.services[ServiceName.make("web")];
  expect(String(web?.appMount?.target)).toBe("/site");
  expect(web?.environment.LANDO_APP_ROOT).toBe("/site");
  expect(String(web?.workingDirectory)).toBe("/site");
});

test.each(["site", "disabled"])(
  "invalid appMount shorthand %s retains its path and both fixes",
  async (appMount) => {
    const exit = await planExit({ type: "apache", appMount });
    if (!Exit.isFailure(exit)) throw new Error("Expected planning failure");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    if (!(error instanceof LandofileValidationError)) throw new Error("Expected landofile validation error");
    expect(error.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
      "services.web.appMount.target",
    ]);
    expect(error.issues[0]?.message).toBe(
      `Container destination ${JSON.stringify(appMount)} must be an absolute path starting with "/".`,
    );
    expect(error.issues[0]?.suggestion).toBe(
      "Set appMount to an absolute container path such as /app, or false to disable the app mount.",
    );
  },
);

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

test.each(["tomcat", "tomcat:10"])(
  "%s leaves an authored Compose build's configuration untouched",
  async (type) => {
    // Given: a Compose build that replaces the catalog image.
    const service = { type, certs: false, build: { context: "." } };
    // When: the full planner selects the authored artifact.
    const exit = await planExit(service, { ...TestRuntimeProvider.capabilities, artifactBuild: true });
    // Then: the build artifact is retained without a Lando-owned ROOT context.
    if (!Exit.isSuccess(exit)) throw new Error(Cause.pretty(exit.cause));
    expect(Exit.isSuccess(exit)).toBe(true);
    const web = exit.value.services[ServiceName.make("web")];
    expect(web?.artifact).toMatchObject({ kind: "build", context: APP_ROOT });
    expect(web?.extensions["@lando/core/service-features"]).not.toMatchObject({
      buildSteps: expect.arrayContaining([
        expect.objectContaining({ id: "service-lando.tomcat:root-context" }),
      ]),
    });
  },
);

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
