import { SchemaIssue } from "effect";
import { describe, expect, test } from "bun:test";

import { DateTime, Result, Schema } from "effect";

import {
  LandoEvent,
  PostGlobalRebuildEvent,
  PostGlobalStartEvent,
  PostGlobalStopEvent,
  PreGlobalRebuildEvent,
  PreGlobalStartEvent,
  PreGlobalStopEvent,
  PreStartEvent,
} from "@lando/sdk/events";
import { AppId, type AppPlan, type ServicePlan } from "@lando/sdk/schema";

const FIXED_TIMESTAMP = DateTime.makeUnsafe("2026-05-11T07:30:00Z");
const FIXED_RESOLVED_AT = DateTime.makeUnsafe("2026-05-10T18:51:00Z");

const timestamp = DateTime.formatIso(FIXED_TIMESTAMP);

const globalAppRef = {
  kind: "global",
  id: "global",
  root: "/home/user/.local/share/lando/global",
} as const;

const servicePlanFixture: typeof ServicePlan.Encoded = {
  name: "traefik",
  type: "compose",
  provider: "lando",
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ _tag: "internal", port: 80, protocol: "http", name: "web" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.formatIso(FIXED_RESOLVED_AT),
    source: "/home/user/.local/share/lando/global/.lando.dist.yml",
    runtime: 4,
  },
  extensions: {},
};

const globalPlanFixture: typeof AppPlan.Encoded = {
  id: "global",
  name: "global",
  slug: "global",
  root: "/home/user/.local/share/lando/global",
  provider: "lando",
  services: { traefik: servicePlanFixture },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.formatIso(FIXED_RESOLVED_AT),
    source: "/home/user/.local/share/lando/global/.lando.dist.yml",
    runtime: 4,
  },
  extensions: {},
};

describe("global lifecycle event payload schemas", () => {
  test("pre-global-start carries scope:global, the global AppRef, plan, and ensure-running metadata", () => {
    const result = Schema.decodeUnknownResult(PreGlobalStartEvent)({
      _tag: "pre-global-start",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      triggeredBy: "meta:global:start",
      ensuringServices: [],
      cached: false,
      timestamp,
    });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.scope).toBe("global");
      expect(result.success.app.kind).toBe("global");
      expect(result.success.app.id).toBe("global");
      expect(result.success.cached).toBe(false);
      expect(result.success.triggeredBy).toBe("meta:global:start");
    }
  });

  test("post-global-start carries scope:global and the cached flag", () => {
    const result = Schema.decodeUnknownResult(PostGlobalStartEvent)({
      _tag: "post-global-start",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      cached: true,
      timestamp,
    });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.scope).toBe("global");
      expect(result.success.cached).toBe(true);
    }
  });

  test("pre-global-stop and post-global-stop carry scope:global", () => {
    const pre = Schema.decodeUnknownResult(PreGlobalStopEvent)({
      _tag: "pre-global-stop",
      scope: "global",
      app: globalAppRef,
      triggeredBy: "meta:global:stop",
      timestamp,
    });
    const post = Schema.decodeUnknownResult(PostGlobalStopEvent)({
      _tag: "post-global-stop",
      scope: "global",
      app: globalAppRef,
      timestamp,
    });

    expect(Result.isSuccess(pre)).toBe(true);
    expect(Result.isSuccess(post)).toBe(true);
    if (Result.isSuccess(pre)) expect(pre.success.scope).toBe("global");
    if (Result.isSuccess(post)) expect(post.success.scope).toBe("global");
  });

  test("pre-global-rebuild and post-global-rebuild carry scope:global and the global plan", () => {
    const pre = Schema.decodeUnknownResult(PreGlobalRebuildEvent)({
      _tag: "pre-global-rebuild",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      timestamp,
    });
    const post = Schema.decodeUnknownResult(PostGlobalRebuildEvent)({
      _tag: "post-global-rebuild",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      services: ["traefik"],
      timestamp,
    });

    expect(Result.isSuccess(pre)).toBe(true);
    expect(Result.isSuccess(post)).toBe(true);
    if (Result.isSuccess(pre)) expect(pre.success.plan.id).toBe(AppId.make("global"));
    if (Result.isSuccess(post)) expect(post.success.services).toEqual(["traefik"]);
  });

  test("the per-app lifecycle analog carries scope:app, distinguishing it from the global scope", () => {
    const result = Schema.decodeUnknownResult(PreStartEvent)({
      _tag: "pre-start",
      scope: "app",
      app: { kind: "user", id: "myapp", root: "/srv/apps/myapp" },
      plan: { ...globalPlanFixture, id: "myapp", name: "myapp", slug: "myapp" },
      triggeredBy: "app:start",
      timestamp,
    });

    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.scope).toBe("app");
    }
  });

  test("rejects a global event whose scope claims to be app with a structured ParseError on the scope path", () => {
    const result = Schema.decodeUnknownResult(PreGlobalStartEvent)({
      _tag: "pre-global-start",
      scope: "app",
      app: globalAppRef,
      plan: globalPlanFixture,
      triggeredBy: "meta:global:start",
      ensuringServices: [],
      cached: false,
      timestamp,
    });

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(Schema.isSchemaError(result.failure)).toBe(true);
      const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
      expect(issues.some((issue) => (issue.path ?? []).includes("scope"))).toBe(true);
    }
  });

  test("the LandoEvent union accepts all six global lifecycle events", () => {
    const payloads = [
      {
        _tag: "pre-global-start",
        scope: "global",
        app: globalAppRef,
        plan: globalPlanFixture,
        triggeredBy: "ensure-running",
        ensuringServices: ["traefik", "mailpit"],
        cached: false,
        timestamp,
      },
      {
        _tag: "post-global-start",
        scope: "global",
        app: globalAppRef,
        plan: globalPlanFixture,
        cached: false,
        timestamp,
      },
      {
        _tag: "pre-global-stop",
        scope: "global",
        app: globalAppRef,
        triggeredBy: "apps:poweroff",
        timestamp,
      },
      { _tag: "post-global-stop", scope: "global", app: globalAppRef, timestamp },
      {
        _tag: "pre-global-rebuild",
        scope: "global",
        app: globalAppRef,
        plan: globalPlanFixture,
        timestamp,
      },
      {
        _tag: "post-global-rebuild",
        scope: "global",
        app: globalAppRef,
        plan: globalPlanFixture,
        services: ["traefik"],
        timestamp,
      },
    ] as const;

    for (const payload of payloads) {
      const result = Schema.decodeUnknownResult(LandoEvent)(payload);
      expect(Result.isSuccess(result)).toBe(true);
      if (Result.isSuccess(result)) {
        expect(result.success._tag).toBe(payload._tag);
      }
    }
  });
});
