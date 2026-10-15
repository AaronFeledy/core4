import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { ServiceFeatureContext } from "@lando/sdk/services";

import { landoEnvFeature } from "../src/features/env.ts";

const featureContext = (config: Readonly<Record<string, unknown>> = {}) => {
  const env: Record<string, string> = {};
  const ctx: ServiceFeatureContext = {
    serviceName: "web",
    serviceType: "php",
    base: "lando",
    primary: true,
    appName: "myapp",
    appRoot: "/srv/apps/myapp",
    normalizedConfig: {},
    config,
    addEnv(name, value) {
      env[name] = value;
    },
    addMount() {},
    setAppMount() {},
    addBuildStep() {},
    addExtension() {},
    addStorage() {},
    addEndpoint() {},
    addDependency() {},
    addHostAlias() {},
    setHealthcheck() {},
    setCerts() {},
    setEntrypoint() {},
    setCommand() {},
    setArtifact() {},
    setUser() {},
    setWorkingDirectory() {},
  };

  return { ctx, env };
};

describe("landoEnvFeature", () => {
  test("omits optional app path and webroot env when feature config is empty", async () => {
    const { ctx, env } = featureContext();

    await Effect.runPromise(landoEnvFeature.apply(ctx));

    expect(env.LANDO_APP_ROOT).toBeUndefined();
    expect(env.LANDO_PROJECT_MOUNT).toBeUndefined();
    expect(env.LANDO_WEBROOT).toBeUndefined();
  });

  test("emits webroot env without owning app paths", async () => {
    const { ctx, env } = featureContext({
      webroot: "/app/web",
    });

    await Effect.runPromise(landoEnvFeature.apply(ctx));

    expect(env.LANDO_APP_ROOT).toBeUndefined();
    expect(env.LANDO_PROJECT_MOUNT).toBeUndefined();
    expect(env.LANDO_WEBROOT).toBe("/app/web");
  });
});
