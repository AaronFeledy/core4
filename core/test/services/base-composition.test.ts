import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceTypeHostFacts } from "@lando/sdk/services";
import { serviceFeatures } from "@lando/service-lando";

import { L337_BASE_DEFAULT_FEATURE_IDS } from "../../src/testing/engine-layers.ts";
import { LANDO_BASE_DEFAULT_FEATURE_IDS } from "../../src/testing/engine-layers.ts";
import { type BaseSeed, type ComposeServiceInput, composeService } from "../../src/testing/engine-layers.ts";

const DIGEST = "a".repeat(64);

const host: ServiceTypeHostFacts = {
  os: "linux",
  user: "lando-user",
  uid: "1000",
  gid: "1000",
  home: "/home/lando-user",
  arch: "x64",
};

const resolveFeatures = (ids: ReadonlyArray<string>): ReadonlyArray<ServiceFeatureDefinition> =>
  ids.map((id) => {
    const definition = serviceFeatures.get(id);
    if (definition === undefined) throw new Error(`feature ${id} not published by @lando/service-lando`);
    return definition;
  });

const baseSeed = (
  baseKind: "l337" | "lando",
  environment: Readonly<Record<string, string>> | undefined,
): BaseSeed => ({
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("lando"),
  primary: true,
  ...(environment === undefined ? {} : { environment }),
  defaultFeatures: resolveFeatures(
    baseKind === "lando" ? LANDO_BASE_DEFAULT_FEATURE_IDS : L337_BASE_DEFAULT_FEATURE_IDS,
  ),
});

const inputFor = (
  baseKind: "l337" | "lando",
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly userEnv?: Readonly<Record<string, string>>;
    readonly appName?: string;
    readonly withHost?: boolean;
  } = {},
): ComposeServiceInput => ({
  base: baseSeed(baseKind, options.environment),
  baseKind,
  appName: options.appName ?? "myapp",
  appRoot: "/srv/apps/myapp",
  ...(options.withHost === true ? { host } : {}),
  normalizedConfig: { type: "node", environment: options.userEnv ?? {} },
  features: [],
});

const compose = (input: ComposeServiceInput): Promise<ServicePlan> =>
  Effect.runPromise(composeService(input));

describe("lando base composition", () => {
  test("seeds boot before env, certs, and security in canonical priority order", () => {
    expect(LANDO_BASE_DEFAULT_FEATURE_IDS).toEqual([
      "lando.boot",
      "lando.user-id",
      "lando.storage",
      "lando.env",
      "lando.app-mount",
      "lando.healthcheck",
      "lando.certs",
      "lando.security",
      "lando.host-proxy",
      "lando.user",
    ]);
  });

  test("keeps default lando.security inert before planner config exists", async () => {
    const plan = await compose(inputFor("lando"));

    expect(plan.mounts.some((mount) => String(mount.target).includes("ca-certificates"))).toBe(false);
    expect(plan.environment.LANDO_CA_BUNDLE).toBeUndefined();
    expect(
      Schema.decodeUnknownSync(
        Schema.Struct({
          buildSteps: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String) }))),
        }),
      )(plan.extensions["@lando/core/service-features"]).buildSteps ?? [],
    ).not.toContainEqual({ id: "lando.security:trust-store" });
  });

  test("preserves the configured CA bundle after boot and security compose", async () => {
    const input = inputFor("lando");
    const security = serviceFeatures.get("lando.security");
    if (security === undefined) throw new Error("lando.security feature missing");
    const plan = await compose({
      ...input,
      base: {
        ...input.base,
        defaultFeatures: input.base.defaultFeatures.filter((feature) => feature.id !== "lando.security"),
      },
      features: [
        {
          id: "lando.security",
          definition: security,
          config: {
            injectCa: true,
            cas: [{ path: "/host/corp.pem", digest: DIGEST }],
            bundlePath: "/host/ca-bundle.pem",
          },
        },
      ],
    });

    expect(plan.extensions["@lando/core/service-features"]).toMatchObject({
      featureIds: [
        "lando.boot",
        "lando.user-id",
        "lando.storage",
        "lando.env",
        "lando.app-mount",
        "lando.healthcheck",
        "lando.certs",
        "lando.security",
        "lando.host-proxy",
        "lando.user",
      ],
      buildSteps: [
        {
          id: "lando.boot:scaffold",
          phase: "build",
          command: "mkdir -p /etc/lando /etc/lando/env.d /etc/lando/certs",
        },
        { id: "lando.security:trust-store", phase: "build" },
      ],
    });
    expect(plan.environment.LANDO_CA_BUNDLE).toBe("/etc/lando/certs/ca-bundle.pem");
    expect(plan.mounts).toContainEqual({
      type: "bind",
      source: "/host/ca-bundle.pem",
      target: PortablePath.make("/etc/lando/certs/ca-bundle.pem"),
      readOnly: true,
      realization: "passthrough",
    });
  });

  test("carries the LANDO_* identity env via lando.env", async () => {
    const plan = await compose(inputFor("lando", { withHost: true }));

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_APP_KIND).toBe("user");
    expect(plan.environment.LANDO_PROJECT).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_API).toBe("4");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("node");
    expect(plan.environment.LANDO_HOST_OS).toBe("linux");
    expect(plan.environment.LANDO_HOST_USER).toBe("lando-user");
    expect(plan.environment.LANDO_HOST_UID).toBe("1000");
    expect(plan.environment.LANDO_HOST_GID).toBe("1000");
    expect(plan.environment.LANDO_HOST_HOME).toBe("/home/lando-user");
  });

  test("preserves user-authored env alongside LANDO_* identity env", async () => {
    const plan = await compose(inputFor("lando", { userEnv: { NODE_ENV: "development" } }));

    expect(plan.environment.NODE_ENV).toBe("development");
    expect(plan.environment.LANDO).toBe("ON");
  });

  test("activates host-proxy by default for lando base services", async () => {
    const plan = await compose(inputFor("lando", { withHost: true }));

    expect(plan.extensions["@lando/core/service-features"]).toMatchObject({
      featureIds: expect.arrayContaining(["lando.host-proxy"]),
    });
  });

  test("marks global-app services and omits global Mailpit env", async () => {
    const plan = await compose(inputFor("lando", { appName: "global" }));

    expect(plan.environment.LANDO_APP_KIND).toBe("global");
    expect(plan.environment.LANDO_MAIL_HOST).toBeUndefined();
    expect(plan.environment.LANDO_MAIL_PORT).toBeUndefined();
  });

  test("derives LANDO_APP_NAME from app root when app name is blank", async () => {
    const plan = await compose({
      ...inputFor("lando"),
      appName: "",
      appRoot: "/srv/apps/my-cool-app",
    });

    expect(plan.environment.LANDO_APP_NAME).toBe("my-cool-app");
    expect(plan.environment.LANDO_PROJECT).toBe("my-cool-app");
  });

  test("rejects user env that collides with reserved LANDO_* keys", async () => {
    const exit = await Effect.runPromiseExit(
      composeService(inputFor("lando", { userEnv: { LANDO_PROJECT: "fake" } })),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ServiceFeatureError");
      expect(exit.cause.error.feature).toBe("lando.env");
    }
  });
});

describe("l337 base composition", () => {
  test("does not seed lando.boot or lando.security", () => {
    expect(L337_BASE_DEFAULT_FEATURE_IDS).not.toContain("lando.boot");
    expect(L337_BASE_DEFAULT_FEATURE_IDS).not.toContain("lando.security");
  });

  test("does not activate host-proxy by default for l337 base services", async () => {
    const plan = await compose(inputFor("l337", { withHost: true }));

    expect(plan.extensions["@lando/core/service-features"] ?? {}).not.toMatchObject({
      featureIds: expect.arrayContaining(["lando.host-proxy"]),
    });
  });

  test("carries only user/Compose-authored env and no LANDO_* identity layer", async () => {
    const plan = await compose(
      inputFor("l337", { environment: { COMPOSE_VAR: "from-compose" }, withHost: true }),
    );

    expect(plan.environment.COMPOSE_VAR).toBe("from-compose");
    expect(plan.environment.LANDO).toBeUndefined();
    expect(plan.environment.LANDO_APP_NAME).toBeUndefined();
    expect(plan.environment.LANDO_SERVICE_API).toBeUndefined();
    expect(plan.environment.LANDO_HOST_OS).toBeUndefined();
    expect(Object.keys(plan.environment).some((key) => key.startsWith("LANDO"))).toBe(false);
  });

  test("seeds no lando.* feature", () => {
    expect(L337_BASE_DEFAULT_FEATURE_IDS).toEqual([]);
  });
});
