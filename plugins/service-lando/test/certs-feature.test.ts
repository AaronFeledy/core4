import { describe, expect, test } from "bun:test";
import { Cause, Effect, Option } from "effect";

import { PortablePath, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { composeService } from "../../../core/src/services/feature.ts";
import { serviceFeatures } from "../src/features/index.ts";

const LANDO_CERTS_FEATURE_ID = "lando.certs";

const certsFeature = (): ServiceFeatureDefinition => {
  const definition = serviceFeatures.get(LANDO_CERTS_FEATURE_ID);
  expect(definition).toBeDefined();
  if (definition === undefined) throw new Error("lando.certs feature missing");
  return definition;
};

const composeCerts = (config: Readonly<Record<string, unknown>> = {}, serviceName = "web") =>
  composeService({
    base: {
      name: ServiceName.make(serviceName),
      type: "node:22",
      provider: ProviderId.make("lando"),
      primary: true,
      defaultFeatures: [],
    },
    baseKind: "lando",
    appName: "certs-test",
    appRoot: "/srv/apps/certs-test",
    normalizedConfig: { type: "node:22" },
    features: [{ id: LANDO_CERTS_FEATURE_ID, config, definition: certsFeature() }],
  });

const composeCertsPlan = (config: Readonly<Record<string, unknown>> = {}): Promise<ServicePlan> =>
  Effect.runPromise(composeCerts(config));

describe("lando.certs feature", () => {
  test("registers lando.certs at priority 1000", () => {
    const definition = certsFeature();

    expect(definition.id).toBe(LANDO_CERTS_FEATURE_ID);
    expect(definition.priority).toBe(1000);
  });

  test("is completely inert for an empty config", async () => {
    const plan = await composeCertsPlan({});

    expect(plan.mounts.filter((mount) => mount.target.startsWith("/etc/lando/certs/leaf"))).toEqual([]);
    expect(plan.environment.LANDO_SERVICE_CERT).toBeUndefined();
    expect(plan.environment.LANDO_SERVICE_KEY).toBeUndefined();
    expect(plan.certs).toBeUndefined();
  });

  test("mounts cert and key read-only and publishes both env vars", async () => {
    const plan = await composeCertsPlan({
      certPath: "/host/certs/web.crt",
      keyPath: "/host/certs/web.key",
    });

    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "/host/certs/web.crt",
        target: PortablePath.make("/etc/lando/certs/leaf/web.crt"),
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: "/host/certs/web.key",
        target: PortablePath.make("/etc/lando/certs/leaf/web.key"),
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    expect(plan.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(plan.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/web.key");
  });

  test("publishes only LANDO_SERVICE_CERT when no key is supplied", async () => {
    const plan = await composeCertsPlan({ certPath: "/host/certs/web.crt" });

    expect(plan.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/web.crt");
    expect(plan.environment.LANDO_SERVICE_KEY).toBeUndefined();
  });

  test("rejects a key without a certificate", async () => {
    const exit = await Effect.runPromiseExit(composeCerts({ keyPath: "/host/certs/web.key" }));

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected feature failure");
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure._tag).toBe("ServiceFeatureError");
    expect(String(failure)).toContain("keyPath requires certPath");
  });

  test("contains service names within the leaf directory", async () => {
    const plan = await Effect.runPromise(
      composeCerts({ certPath: "/host/certs/web.crt", keyPath: "/host/certs/web.key" }, "../outside"),
    );

    expect(plan.environment.LANDO_SERVICE_CERT).toBe("/etc/lando/certs/leaf/%2E%2E%2Foutside.crt");
    expect(plan.environment.LANDO_SERVICE_KEY).toBe("/etc/lando/certs/leaf/%2E%2E%2Foutside.key");
  });

  test("records the certificate plan when cn and caId are present", async () => {
    const plan = await composeCertsPlan({
      cn: "web.certs-test.internal",
      sans: ["web", "web.certs-test.internal"],
      caId: "mkcert",
    });

    expect(plan.certs).toEqual({
      cn: "web.certs-test.internal",
      sans: ["web", "web.certs-test.internal"],
      caId: "mkcert",
    });
  });

  test("omits the certificate plan for user-supplied certs", async () => {
    const plan = await composeCertsPlan({
      certPath: "/host/certs/custom.crt",
      keyPath: "/host/certs/custom.key",
    });

    expect(plan.certs).toBeUndefined();
  });

  test("rejects malformed config through the feature schema", async () => {
    const exit = await Effect.runPromiseExit(composeCerts({ certPath: 42 }));

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new Error("expected feature failure");
    const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
    expect(failure._tag).toBe("ServiceFeatureError");
    expect(failure.feature).toBe(LANDO_CERTS_FEATURE_ID);
  });
});
