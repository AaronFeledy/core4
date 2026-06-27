import { describe, expect, test } from "bun:test";

import { DateTime, Either, ParseResult, Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  AppPlan,
  AppRef,
  DataStorePlan,
  PortablePath,
  ProviderId,
  ServiceName,
  ServicePlan,
} from "@lando/sdk/schema";

const FIXED_RESOLVED_AT = DateTime.unsafeMake("2026-05-10T18:51:00Z");

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
  storage: [],
  endpoints: [
    {
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
      const result = Schema.decodeUnknownEither(AppRef)({
        kind,
        id: kind === "global" ? "global" : "myapp",
        root: "/srv/apps/myapp",
      });
      expect(Either.isRight(result)).toBe(true);
    }
  });

  test("rejects an unknown kind discriminator with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(AppRef)({
      kind: "bogus",
      id: "myapp",
      root: "/srv/apps/myapp",
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.some((issue) => issue.path.includes("kind"))).toBe(true);
    }
  });

  test("rejects missing required fields with a structured ParseError", () => {
    const result = Schema.decodeUnknownEither(AppRef)({ kind: "user", id: "myapp" });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("root"))).toBe(true);
    }
  });
});

describe("ServicePlan", () => {
  test("decodes a minimal MVP service (one mount, one endpoint) and preserves required fields", () => {
    const decoded = Schema.decodeUnknownSync(ServicePlan)(servicePlanFixture);
    expect(decoded.name).toBe(ServiceName.make("web"));
    expect(decoded.type).toBe("node");
    expect(decoded.provider).toBe(ProviderId.make("lando"));
    expect(decoded.primary).toBe(true);
    expect(decoded.environment).toEqual({ NODE_ENV: "development" });
    expect(decoded.mounts).toHaveLength(1);
    expect(decoded.mounts[0]?.target).toBe(PortablePath.make("/app"));
    expect(decoded.mounts[0]?.realization).toBe("passthrough");
    expect(decoded.endpoints).toHaveLength(1);
    expect(decoded.endpoints[0]?.port).toBe(3000);
    expect(decoded.endpoints[0]?.protocol).toBe("http");
    expect(decoded.metadata.runtime).toBe(4);
  });

  test("rejects a malformed service (missing required `metadata`) with a structured ParseError", () => {
    const { metadata: _omitted, ...withoutMetadata } = servicePlanFixture;
    const result = Schema.decodeUnknownEither(ServicePlan)(withoutMetadata);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("metadata"))).toBe(true);
    }
  });

  test("rejects an unknown endpoint protocol literal", () => {
    const result = Schema.decodeUnknownEither(ServicePlan)({
      ...servicePlanFixture,
      endpoints: [{ port: 3000, protocol: "websocket" }],
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
    }
  });
});

describe("AppPlan", () => {
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
    const result = Schema.decodeUnknownEither(AppPlan)(withoutId);
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("id"))).toBe(true);
    }
  });

  test("rejects malformed nested service inside `services` record", () => {
    const result = Schema.decodeUnknownEither(AppPlan)({
      ...appPlanFixture,
      services: { web: { ...servicePlanFixture, primary: "yes" } },
    });
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("services") && issue.path.includes("primary"))).toBe(
        true,
      );
    }
  });
});
