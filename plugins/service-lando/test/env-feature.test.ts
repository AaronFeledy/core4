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

  test("emits optional app path and webroot env from decoded feature config", async () => {
    const { ctx, env } = featureContext({
      appPaths: { appRoot: "/app", projectMount: "/app" },
      webroot: "/app/web",
    });

    await Effect.runPromise(landoEnvFeature.apply(ctx));

    expect(env.LANDO_APP_ROOT).toBe("/app");
    expect(env.LANDO_PROJECT_MOUNT).toBe("/app");
    expect(env.LANDO_WEBROOT).toBe("/app/web");
  });
});
