import { describe, expect, test } from "bun:test";
import { SchemaIssue } from "effect";

import { DateTime, Result, Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  AppPlan,
  AppRef,
  CurrentExecutableAppPlan,
  DataStorePlan,
  PortablePath,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";

const FIXED_RESOLVED_AT = DateTime.makeUnsafe("2026-05-10T18:51:00Z");

const planMetadataFixture = {
  resolvedAt: FIXED_RESOLVED_AT,
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const servicePlanFixture: typeof ServicePlan.Encoded = {
  name: "web",
  type: "node",
  provider: "lando",
  primary: true,
  environment: { NODE_ENV: "development" },
  mounts: [
    {
      type: "bind",
      source: "/srv/apps/myapp",
      target: "/app",
      readOnly: false,
      realization: "passthrough",
    },
  ],
  endpoints: [
    {
      _tag: "internal",
      port: 3000,
      protocol: "http",
      name: "web",
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.formatIso(FIXED_RESOLVED_AT),
    source: planMetadataFixture.source,
    runtime: 4,
  },
  extensions: {},
};

const appPlanFixture: typeof AppPlan.Encoded = {
  id: "myapp",
  name: "My App",
  slug: "myapp",
  root: "/srv/apps/myapp",
  provider: "lando",
  services: { web: servicePlanFixture },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.formatIso(FIXED_RESOLVED_AT),
    source: planMetadataFixture.source,
    runtime: 4,
  },
  extensions: {},
};

describe("AppRef", () => {
  test("decodes the three identity-namespace kinds (user | global | scratch)", () => {
    for (const kind of ["user", "global", "scratch"] as const) {
      const result = Schema.decodeUnknownResult(AppRef)({
        kind,
        id: kind === "global" ? "global" : "myapp",
        root: "/srv/apps/myapp",
      });
      expect(Result.isSuccess(result)).toBe(true);
    }
  });

  test("rejects an unknown kind discriminator with a structured ParseError", () => {
    const result = Schema.decodeUnknownResult(AppRef)({
      kind: "bogus",
      id: "myapp",
      root: "/srv/apps/myapp",
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((issue) => (issue.path ?? []).includes("kind"))).toBe(true);
    }
  });

  test("rejects missing required fields with a structured ParseError", () => {
    const result = Schema.decodeUnknownResult(AppRef)({ kind: "user", id: "myapp" });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("root"))).toBe(true);
    }
  });
});

describe("ServicePlan", () => {
  test.each(["redis-password", { _tag: "SecretRef", reference: "REDIS_PASSWORD" }])(
    "rejects coexisting SQL connection and non-SQL credentials with password %j",
    (password) => {
      // Given
      const creds = { user: "default", password, database: "0" };
      const service = {
        ...servicePlanFixture,
        connection: { family: "postgres", port: 5432, creds },
        nonSqlCreds: creds,
      };
      // When
      const result = Schema.decodeUnknownResult(ServicePlan)(service);
      const appResult = Schema.decodeUnknownResult(AppPlan)({
        ...appPlanFixture,
        services: { web: service },
      });
      // Then
      expect(Result.isFailure(result)).toBe(true);
      expect(Result.isFailure(appResult)).toBe(true);
    },
  );

  test("decodes a minimal MVP service (one mount, one endpoint) and preserves required fields", () => {
    const decoded = Schema.decodeUnknownSync(ServicePlan)(servicePlanFixture);
    expect(decoded.name).toBe(ServiceName.make("web"));
    expect(decoded.type).toBe("node");
    expect(decoded.provider).toBe(ProviderId.make("lando"));
    expect(decoded.primary).toBe(true);
    expect(decoded.environment).toEqual({ NODE_ENV: "development" });
    expect(decoded.mounts).toHaveLength(1);
    const mount = decoded.mounts[0];
    if (mount === undefined || mount.type !== "bind") throw new Error("expected bind mount");
    expect(mount.target).toBe(PortablePath.make("/app"));
    expect(mount.realization).toBe("passthrough");
    expect(decoded.endpoints).toHaveLength(1);
    const endpoint = decoded.endpoints[0];
    if (endpoint === undefined) throw new Error("endpoint missing");
    expect(endpoint._tag).toBe("internal");
    if (endpoint._tag !== "internal" || endpoint.protocol === "unix") {
      throw new Error("expected an internal TCP endpoint");
    }
    expect(endpoint.port).toBe(3000);
    expect(endpoint.protocol).toBe("http");
    expect(decoded.metadata.runtime).toBe(4);
  });

  test.each([
    "${secret:TOKEN}",
    { _tag: "SecretRef", reference: "TOKEN" },
    { _tag: "BoundText", parts: ["prefix", { reference: "TOKEN", encoding: "uri-component" }] },
  ] as const)("round-trips environment descriptors through JSON: %j", (value) => {
    // Given
    const authored = { ...servicePlanFixture, environment: { TOKEN: value } };
    // When
    const json = JSON.stringify(
      Schema.encodeSync(ServicePlan)(Schema.decodeUnknownSync(ServicePlan)(authored)),
    );
    const decoded = Schema.decodeUnknownSync(ServicePlan)(JSON.parse(json));
    // Then
    expect(decoded.environment).toEqual({ TOKEN: value });
  });

  test("rejects a malformed service (missing required `metadata`) with a structured ParseError", () => {
    const { metadata: _omitted, ...withoutMetadata } = servicePlanFixture;
    const result = Schema.decodeUnknownResult(ServicePlan)(withoutMetadata);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("metadata"))).toBe(true);
    }
  });

  test("rejects an unknown endpoint protocol literal", () => {
    const result = Schema.decodeUnknownResult(ServicePlan)({
      ...servicePlanFixture,
      endpoints: [{ _tag: "internal", port: 3000, protocol: "websocket" }],
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
    }
  });
});

describe("AppPlan", () => {
  test("preserves current eligibility and typed event values through a strict JSON roundtrip", () => {
    // Given
    const input = {
      ...appPlanFixture,
      valueModel: 1,
      events: {
        "pre-start": [
          {
            step: { cmd: "echo ready", env: { TOKEN: { _tag: "SecretRef", reference: "TOKEN" } } },
            source: "host",
            sourceIndex: 3,
            status: "active",
          },
        ],
      },
    } as const;
    const strict = { onExcessProperty: "error" } as const;
    // When
    const plan = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(input, strict);
    const decoded = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(
      JSON.parse(JSON.stringify(Schema.encodeSync(CurrentExecutableAppPlan)(plan))),
      strict,
    );
    // Then
    expect(decoded.valueModel).toBe(1);
    expect(decoded.events).toEqual(input.events);
  });

  test("preserves missing legacy eligibility and requires an explicit current marker", () => {
    // Given
    const historical = appPlanFixture;
    // When
    const observed = Schema.decodeUnknownSync(AppPlan)(historical);
    const executable = Schema.decodeUnknownResult(CurrentExecutableAppPlan)(historical);
    // Then
    expect(Object.hasOwn(observed, "valueModel")).toBe(false);
    expect(Result.isFailure(executable)).toBe(true);
    expect(
      Schema.decodeUnknownSync(CurrentExecutableAppPlan)({ ...historical, valueModel: 1 }).valueModel,
    ).toBe(1);
  });
  test("decodes data stores with default data kind and explicit cache keys", () => {
    const dataStore = Schema.decodeUnknownSync(DataStorePlan)({
      name: "myapp-db-data",
      scope: "app",
    });
    expect(dataStore.kind).toBe("data");

    const cacheStore = Schema.decodeUnknownSync(DataStorePlan)({
      name: "lando-cache-npm",
      scope: "global",
      kind: "cache",
      key: "npm",
    });
    expect(cacheStore).toMatchObject({ kind: "cache", key: "npm" });
  });

  test("decodes a minimal MVP app (one service, one mount, one endpoint)", () => {
    const decoded = Schema.decodeUnknownSync(AppPlan)(appPlanFixture);
    expect(decoded.id).toBe(AppId.make("myapp"));
    expect(decoded.name).toBe("My App");
    expect(decoded.slug).toBe("myapp");
    expect(decoded.root).toBe(AbsolutePath.make("/srv/apps/myapp"));
    expect(decoded.provider).toBe(ProviderId.make("lando"));
    expect(Object.keys(decoded.services)).toEqual(["web"]);
    const web = decoded.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect(web.mounts).toHaveLength(1);
    expect(web.endpoints).toHaveLength(1);
    expect(decoded.routes).toEqual([]);
    expect(decoded.networks).toEqual([]);
    expect(decoded.stores).toEqual([]);
    expect(decoded.metadata.runtime).toBe(4);
  });

  test("rejects a malformed plan (missing required `id`) with a structured ParseError", () => {
    const { id: _omitted, ...withoutId } = appPlanFixture;
    const result = Schema.decodeUnknownResult(AppPlan)(withoutId);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("id"))).toBe(true);
    }
  });

  test("rejects malformed nested service inside `services` record", () => {
    const result = Schema.decodeUnknownResult(AppPlan)({
      ...appPlanFixture,
      services: { web: { ...servicePlanFixture, primary: "yes" } },
    });
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(
        issues.some(
          (issue) => (issue.path ?? []).includes("services") && (issue.path ?? []).includes("primary"),
        ),
      ).toBe(true);
    }
  });
});
