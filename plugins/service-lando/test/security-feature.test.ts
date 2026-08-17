import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition } from "@lando/sdk/services";

import { composeService } from "@lando/core/testing";
import { serviceFeatures } from "../src/features/index.ts";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const FeatureExtension = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        phase: Schema.String,
        command: Schema.Unknown,
        buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
        caFiles: Schema.optional(
          Schema.Array(
            Schema.Struct({
              path: Schema.String,
              digest: Schema.String,
              archiveName: Schema.String,
            }),
          ),
        ),
      }),
    ),
  ),
});

const securityFeature = (): ServiceFeatureDefinition => {
  const definition = serviceFeatures.get("lando.security");
  expect(definition).toBeDefined();
  if (definition === undefined) throw new Error("lando.security feature missing");
  return definition;
};

const composeSecurity = (
  config: Readonly<Record<string, unknown>> = {},
  serviceType = "node:22",
  environment: Readonly<Record<string, string>> = {},
) =>
  composeService({
    base: {
      name: ServiceName.make("web"),
      type: serviceType,
      provider: ProviderId.make("lando"),
      primary: true,
      environment,
      defaultFeatures: [],
    },
    baseKind: "lando",
    appName: "security-test",
    appRoot: "/srv/apps/security-test",
    normalizedConfig: { type: serviceType, environment },
    features: [{ id: "lando.security", config, definition: securityFeature() }],
  });

const composeSecurityPlan = (
  config: Readonly<Record<string, unknown>> = {},
  serviceType = "node:22",
  environment: Readonly<Record<string, string>> = {},
): Promise<ServicePlan> => Effect.runPromise(composeSecurity(config, serviceType, environment));

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(FeatureExtension)(plan.extensions["@lando/core/service-features"]).buildSteps ??
  [];

const caEnvironment = (plan: ServicePlan): Readonly<Record<string, string | undefined>> => ({
  NODE_EXTRA_CA_CERTS: plan.environment.NODE_EXTRA_CA_CERTS,
  REQUESTS_CA_BUNDLE: plan.environment.REQUESTS_CA_BUNDLE,
  SSL_CERT_FILE: plan.environment.SSL_CERT_FILE,
  SSL_CERT_DIR: plan.environment.SSL_CERT_DIR,
  LANDO_CA_CERT: plan.environment.LANDO_CA_CERT,
  LANDO_CA_BUNDLE: plan.environment.LANDO_CA_BUNDLE,
  LANDO_CA_DIR: plan.environment.LANDO_CA_DIR,
});

describe("lando.security feature", () => {
  test("treats empty default config as a no-op", async () => {
    const plan = await composeSecurityPlan();

    expect(plan.mounts).toEqual([]);
    expect(plan.environment).toEqual({});
    expect(buildStepsFor(plan)).toEqual([]);
  });

  test("rejects a non-SHA-256 digest before constructing mount intent", async () => {
    expect(serviceFeatures.has("lando.security")).toBe(true);
    const exit = await Effect.runPromiseExit(
      composeSecurity({
        injectCa: true,
        cas: [{ path: "/host/corp.pem", digest: "not-a-digest" }],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error._tag).toBe("ServiceFeatureError");
      expect(exit.cause.error.feature).toBe("lando.security");
    }
  });

  test("ignores CA payload when CA injection is disabled", async () => {
    const plan = await composeSecurityPlan({
      injectCa: false,
      cas: [{ path: "/host/corp.pem", digest: DIGEST_A }],
    });

    expect(plan.mounts).toEqual([]);
    expect(caEnvironment(plan)).toEqual({
      NODE_EXTRA_CA_CERTS: undefined,
      REQUESTS_CA_BUNDLE: undefined,
      SSL_CERT_FILE: undefined,
      SSL_CERT_DIR: undefined,
      LANDO_CA_CERT: undefined,
      LANDO_CA_BUNDLE: undefined,
      LANDO_CA_DIR: undefined,
    });
    expect(buildStepsFor(plan)).toEqual([]);
  });

  test("materializes CA mounts, trust env, and sorted build-key inputs", async () => {
    const plan = await composeSecurityPlan({
      injectCa: true,
      cas: [
        { path: "/host/b.pem", digest: DIGEST_B },
        { path: "/host/a.pem", digest: DIGEST_A },
      ],
    });

    expect(plan.mounts).toEqual([
      {
        type: "bind",
        source: "/host/b.pem",
        target: PortablePath.make(`/usr/local/share/ca-certificates/lando-${DIGEST_B}.crt`),
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: "/host/a.pem",
        target: PortablePath.make(`/usr/local/share/ca-certificates/lando-${DIGEST_A}.crt`),
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    expect(caEnvironment(plan)).toEqual({
      NODE_EXTRA_CA_CERTS: "/etc/lando/certs/ca-bundle.pem",
      REQUESTS_CA_BUNDLE: undefined,
      SSL_CERT_FILE: "/etc/lando/certs/ca-bundle.pem",
      SSL_CERT_DIR: "/etc/lando/certs",
      LANDO_CA_CERT: "/etc/lando/certs/ca-bundle.pem",
      LANDO_CA_BUNDLE: "/etc/lando/certs/ca-bundle.pem",
      LANDO_CA_DIR: "/etc/lando/certs",
    });
    expect(buildStepsFor(plan)).toEqual([
      {
        id: "lando.security:trust-store",
        phase: "build",
        command:
          "set -e; mkdir -p /etc/lando/certs; if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; elif command -v update-ca-trust >/dev/null 2>&1; then mkdir -p /etc/pki/ca-trust/source/anchors && cp /usr/local/share/ca-certificates/lando-*.crt /etc/pki/ca-trust/source/anchors/ && update-ca-trust extract; else echo 'No supported CA trust-store installer found.' >&2; exit 1; fi; cat /usr/local/share/ca-certificates/lando-*.crt > /etc/lando/certs/ca-bundle.pem",
        buildKeyInputs: { caDigests: [DIGEST_A, DIGEST_B] },
        caFiles: [
          { path: "/host/b.pem", digest: DIGEST_B, archiveName: `lando-${DIGEST_B}.crt` },
          { path: "/host/a.pem", digest: DIGEST_A, archiveName: `lando-${DIGEST_A}.crt` },
        ],
      },
    ]);
  });

  test("emits only defined proxy environment when proxy injection is enabled", async () => {
    const plan = await composeSecurityPlan({
      injectProxy: true,
      proxy: {
        https: "http://proxy.example.test:8443",
        noProxy: ["localhost", ".lndo.site"],
      },
    });

    expect(plan.environment.HTTP_PROXY).toBeUndefined();
    expect(plan.environment.HTTPS_PROXY).toBe("http://proxy.example.test:8443");
    expect(plan.environment.NO_PROXY).toBe("localhost,.lndo.site");
    expect(plan.mounts).toEqual([]);
    expect(buildStepsFor(plan)).toEqual([]);
  });

  test("adds the Requests CA bundle to Python services when CA injection is active", async () => {
    const plan = await composeSecurityPlan(
      {
        injectCa: true,
        cas: [{ path: "/host/corp.pem", digest: DIGEST_A }],
      },
      "python:3.12",
    );

    expect(plan.environment.REQUESTS_CA_BUNDLE).toBe("/etc/lando/certs/ca-bundle.pem");
    expect(plan.environment.SSL_CERT_FILE).toBe("/etc/lando/certs/ca-bundle.pem");
  });

  test("preserves an authored Python SSL certificate file when CA injection is active", async () => {
    const plan = await composeSecurityPlan(
      {
        injectCa: true,
        cas: [{ path: "/host/corp.pem", digest: DIGEST_A }],
      },
      "python:3.12",
      { SSL_CERT_FILE: "/app/certs/python.pem" },
    );

    expect(plan.environment.REQUESTS_CA_BUNDLE).toBe("/etc/lando/certs/ca-bundle.pem");
    expect(plan.environment.SSL_CERT_FILE).toBe("/app/certs/python.pem");
  });

  test("omits the Requests CA bundle from Python services without injected CA material", async () => {
    const plan = await composeSecurityPlan({}, "python:3.12");

    expect(plan.environment.REQUESTS_CA_BUNDLE).toBeUndefined();
  });

  test("omits the Requests CA bundle from unregistered Python service ids", async () => {
    const plan = await composeSecurityPlan(
      {
        injectCa: true,
        cas: [{ path: "/host/corp.pem", digest: DIGEST_A }],
      },
      "python:9.9",
    );

    expect(plan.environment.REQUESTS_CA_BUNDLE).toBeUndefined();
  });

  for (const serviceType of ["node:22", "php:8.3", "ruby:3.3", "go:1.23"]) {
    test(`does not add the Python-specific CA environment to ${serviceType}`, async () => {
      const plan = await composeSecurityPlan(
        {
          injectCa: true,
          cas: [{ path: "/host/corp.pem", digest: DIGEST_A }],
        },
        serviceType,
      );

      expect(plan.environment.REQUESTS_CA_BUNDLE).toBeUndefined();
    });
  }

  test("keeps CA bundle environment stable across host materialization paths", async () => {
    const before = await composeSecurityPlan({
      injectCa: true,
      cas: [{ path: "/host/cache/corp.pem", digest: DIGEST_A }],
    });
    const after = await composeSecurityPlan({
      injectCa: true,
      cas: [{ path: "/host/archive/corp.pem", digest: DIGEST_A }],
    });

    expect(caEnvironment(before)).toEqual(caEnvironment(after));
  });
});
