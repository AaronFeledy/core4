import { describe, expect, test } from "bun:test";

import { DateTime, Either, ParseResult, Schema } from "effect";

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
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";

const FIXED_TIMESTAMP = DateTime.unsafeMake("2026-05-11T07:30:00Z");
const FIXED_RESOLVED_AT = DateTime.unsafeMake("2026-05-10T18:51:00Z");

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
    const result = Schema.decodeUnknownEither(PreGlobalStartEvent)({
      _tag: "pre-global-start",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      triggeredBy: "meta:global:start",
      ensuringServices: [],
      cached: false,
      timestamp,
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.scope).toBe("global");
      expect(result.right.app.kind).toBe("global");
      expect(result.right.app.id).toBe("global");
      expect(result.right.cached).toBe(false);
      expect(result.right.triggeredBy).toBe("meta:global:start");
    }
  });

  test("post-global-start carries scope:global and the cached flag", () => {
    const result = Schema.decodeUnknownEither(PostGlobalStartEvent)({
      _tag: "post-global-start",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      cached: true,
      timestamp,
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.scope).toBe("global");
      expect(result.right.cached).toBe(true);
    }
  });

  test("pre-global-stop and post-global-stop carry scope:global", () => {
    const pre = Schema.decodeUnknownEither(PreGlobalStopEvent)({
      _tag: "pre-global-stop",
      scope: "global",
      app: globalAppRef,
      triggeredBy: "meta:global:stop",
      timestamp,
    });
    const post = Schema.decodeUnknownEither(PostGlobalStopEvent)({
      _tag: "post-global-stop",
      scope: "global",
      app: globalAppRef,
      timestamp,
    });

    expect(Either.isRight(pre)).toBe(true);
    expect(Either.isRight(post)).toBe(true);
    if (Either.isRight(pre)) expect(pre.right.scope).toBe("global");
    if (Either.isRight(post)) expect(post.right.scope).toBe("global");
  });

  test("pre-global-rebuild and post-global-rebuild carry scope:global and the global plan", () => {
    const pre = Schema.decodeUnknownEither(PreGlobalRebuildEvent)({
      _tag: "pre-global-rebuild",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      timestamp,
    });
    const post = Schema.decodeUnknownEither(PostGlobalRebuildEvent)({
      _tag: "post-global-rebuild",
      scope: "global",
      app: globalAppRef,
      plan: globalPlanFixture,
      services: ["traefik"],
      timestamp,
    });

    expect(Either.isRight(pre)).toBe(true);
    expect(Either.isRight(post)).toBe(true);
    if (Either.isRight(pre)) expect(pre.right.plan.id).toBe("global");
    if (Either.isRight(post)) expect(post.right.services).toEqual(["traefik"]);
  });

  test("the per-app lifecycle analog carries scope:app, distinguishing it from the global scope", () => {
    const result = Schema.decodeUnknownEither(PreStartEvent)({
      _tag: "pre-start",
      scope: "app",
      app: { kind: "user", id: "myapp", root: "/srv/apps/myapp" },
      plan: { ...globalPlanFixture, id: "myapp", name: "myapp", slug: "myapp" },
      triggeredBy: "app:start",
      timestamp,
    });

    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) {
      expect(result.right.scope).toBe("app");
    }
  });

  test("rejects a global event whose scope claims to be app with a structured ParseError on the scope path", () => {
    const result = Schema.decodeUnknownEither(PreGlobalStartEvent)({
      _tag: "pre-global-start",
      scope: "app",
      app: globalAppRef,
      plan: globalPlanFixture,
      triggeredBy: "meta:global:start",
      ensuringServices: [],
      cached: false,
      timestamp,
    });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(ParseResult.isParseError(result.left)).toBe(true);
      const issues = ParseResult.ArrayFormatter.formatErrorSync(result.left);
      expect(issues.some((issue) => issue.path.includes("scope"))).toBe(true);
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
    ];

    for (const payload of payloads) {
      const result = Schema.decodeUnknownEither(LandoEvent)(payload);
      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right._tag).toBe(payload._tag);
      }
    }
  });
});
