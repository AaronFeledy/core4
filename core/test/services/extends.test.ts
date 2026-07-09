import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";

import { ServiceTypeCollisionError } from "@lando/core/errors";
import type { ServiceConfig } from "@lando/core/schema";
import type { FeatureRef, ServiceType, ServiceTypeInput, ServiceTypeResolution } from "@lando/sdk/services";

import {
  MAX_SERVICE_TYPE_EXTENDS_DEPTH,
  composeExtendedServiceType,
  mergeResolutionOverParent,
} from "../../src/services/extends.ts";

const emptyConfig = (): ServiceConfig => ({}) as ServiceConfig;

const makeType = (
  id: string,
  options: {
    readonly extends?: string;
    readonly base?: "l337" | "lando";
    readonly artifacts?: Record<string, string>;
    readonly versions?: ReadonlyArray<string>;
    readonly resolution?: (input: ServiceTypeInput) => ServiceTypeResolution;
    readonly marker?: boolean;
  } = {},
): ServiceType => {
  const base = options.base ?? "lando";
  const type: ServiceType & { privateMarker?: () => unknown } = {
    id,
    name: id,
    base,
    schema: Schema.Unknown,
    ...(options.extends === undefined ? {} : { extends: options.extends }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.versions === undefined ? {} : { versions: options.versions }),
    resolve: (input: ServiceTypeInput): Effect.Effect<ServiceTypeResolution, never> =>
      Effect.succeed(options.resolution?.(input) ?? { base, normalizedConfig: input.service, features: [] }),
  };
  if (options.marker === true) type.privateMarker = () => ({ marker: id });
  return type;
};

const runInput = (service: ServiceConfig = emptyConfig()): ServiceTypeInput => ({
  name: "web",
  service,
  appRoot: "/app",
  metadata: { resolvedAt: "2026-01-01T00:00:00.000Z", source: "/app/.lando.yml", runtime: 4 },
});

describe("composeExtendedServiceType", () => {
  test("returns the type unchanged when it declares no extends", async () => {
    const type = makeType("mariadb");
    const composed = await Effect.runPromise(composeExtendedServiceType(type, () => undefined));
    expect(composed).toBe(type);
  });

  test("resolves a child extends parent, merging features and config parent-first", async () => {
    const parent = makeType("mariadb", {
      base: "lando",
      resolution: (input) => ({
        base: "lando",
        normalizedConfig: { ...input.service, database: "parentdb" } as ServiceConfig,
        features: [{ id: "lando.storage" }, { id: "lando.env", config: { from: "parent" } }],
      }),
    });
    const child = makeType("drupal-mariadb", {
      extends: "mariadb",
      base: "lando",
      resolution: (input) => ({
        base: "lando",
        normalizedConfig: { ...input.service, user: "drupal" } as ServiceConfig,
        features: [{ id: "lando.env", config: { from: "child" } }, { id: "drupal.settings" }],
      }),
    });
    const lookup = (id: string): ServiceType | undefined => (id === "mariadb" ? parent : undefined);

    const composed = await Effect.runPromise(composeExtendedServiceType(child, lookup));
    const resolution = await Effect.runPromise(composed.resolve(runInput()));

    expect(resolution.base).toBe("lando");
    expect(resolution.normalizedConfig.database).toBe("parentdb");
    expect(resolution.normalizedConfig.user).toBe("drupal");
    const featureIds = resolution.features.map((f: FeatureRef) => f.id);
    expect(featureIds).toEqual(["lando.storage", "lando.env", "drupal.settings"]);
    const env = resolution.features.find((f: FeatureRef) => f.id === "lando.env");
    expect(env?.config).toEqual({ from: "child" });
  });

  test("preserves the leaf's private fields and merges artifacts/versions", async () => {
    const parent = makeType("mariadb", {
      artifacts: { "10.11": "mariadb:10.11", "10.5": "mariadb:10.5" },
      versions: ["10.11", "10.5"],
    });
    const child = makeType("drupal-mariadb", {
      extends: "mariadb",
      artifacts: { "10.11": "drupal/mariadb:10.11" },
      versions: ["10.11"],
      marker: true,
    });
    const lookup = (id: string): ServiceType | undefined => (id === "mariadb" ? parent : undefined);

    const composed = (await Effect.runPromise(composeExtendedServiceType(child, lookup))) as ServiceType & {
      privateMarker?: () => unknown;
    };

    expect(typeof composed.privateMarker).toBe("function");
    expect(composed.artifacts).toEqual({ "10.11": "drupal/mariadb:10.11", "10.5": "mariadb:10.5" });
    expect(composed.versions).toEqual(["10.11", "10.5"]);
  });

  test("rejects an extends chain deeper than the maximum depth", async () => {
    const types = new Map<string, ServiceType>();
    types.set("level0", makeType("level0"));
    for (let i = 1; i <= MAX_SERVICE_TYPE_EXTENDS_DEPTH + 1; i += 1) {
      types.set(`level${i}`, makeType(`level${i}`, { extends: `level${i - 1}` }));
    }
    const leaf = types.get(`level${MAX_SERVICE_TYPE_EXTENDS_DEPTH + 1}`) as ServiceType;
    const exit = await Effect.runPromiseExit(composeExtendedServiceType(leaf, (id) => types.get(id)));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(ServiceTypeCollisionError);
      expect((error as ServiceTypeCollisionError).message).toContain("maximum extends depth");
    }
  });

  test("rejects a cyclic extends chain", async () => {
    const types = new Map<string, ServiceType>();
    types.set("a", makeType("a", { extends: "b" }));
    types.set("b", makeType("b", { extends: "a" }));
    const exit = await Effect.runPromiseExit(
      composeExtendedServiceType(types.get("a") as ServiceType, (id) => types.get(id)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(ServiceTypeCollisionError);
      expect((error as ServiceTypeCollisionError).message).toContain("cyclic");
    }
  });

  test("rejects an extends reference to an unregistered parent", async () => {
    const child = makeType("orphan", { extends: "ghost" });
    const exit = await Effect.runPromiseExit(composeExtendedServiceType(child, () => undefined));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
      expect(error).toBeInstanceOf(ServiceTypeCollisionError);
      expect((error as ServiceTypeCollisionError).message).toContain("unregistered parent");
    }
  });

  test("allows a chain at exactly the maximum depth", async () => {
    const types = new Map<string, ServiceType>();
    types.set("level0", makeType("level0"));
    for (let i = 1; i <= MAX_SERVICE_TYPE_EXTENDS_DEPTH; i += 1) {
      types.set(`level${i}`, makeType(`level${i}`, { extends: `level${i - 1}` }));
    }
    const leaf = types.get(`level${MAX_SERVICE_TYPE_EXTENDS_DEPTH}`) as ServiceType;
    const composed = await Effect.runPromise(composeExtendedServiceType(leaf, (id) => types.get(id)));
    const resolution = await Effect.runPromise(composed.resolve(runInput()));
    expect(resolution.base).toBe("lando");
  });
});

describe("mergeResolutionOverParent", () => {
  test("child base, merged config, features-by-id, child-wins tooling", () => {
    const parent: ServiceTypeResolution = {
      base: "l337",
      normalizedConfig: { database: "a", user: "p" } as ServiceConfig,
      features: [{ id: "x" }, { id: "y", config: { k: 1 } }],
      tooling: { db: { service: "web", cmd: "parent" } },
    };
    const child: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: { user: "c" } as ServiceConfig,
      features: [{ id: "y", config: { k: 2 } }, { id: "z" }],
      tooling: { db: { service: "web", cmd: "child" } },
    };

    const merged = mergeResolutionOverParent(parent, child);
    expect(merged.base).toBe("lando");
    expect(merged.normalizedConfig.database).toBe("a");
    expect(merged.normalizedConfig.user).toBe("c");
    expect(merged.features.map((f) => f.id)).toEqual(["x", "y", "z"]);
    expect(merged.features.find((f) => f.id === "y")?.config).toEqual({ k: 2 });
    expect(merged.tooling?.db?.cmd).toBe("child");
  });

  test("merges normalizedConfig object arrays by identity key, not wholesale replace", () => {
    const parent: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {
        endpoints: [
          { name: "web", port: 80, protocol: "http" },
          { name: "metrics", port: 9090, protocol: "http" },
        ],
      } as ServiceConfig,
      features: [],
    };
    const child: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {
        endpoints: [{ name: "web", port: 8080, protocol: "http" }],
      } as ServiceConfig,
      features: [],
    };

    const merged = mergeResolutionOverParent(parent, child);
    const endpoints = merged.normalizedConfig.endpoints ?? [];
    expect(endpoints.map((e) => e.name)).toEqual(["web", "metrics"]);
    expect(endpoints.find((e) => e.name === "web")?.port).toBe(8080);
    expect(endpoints.find((e) => e.name === "metrics")?.port).toBe(9090);
  });

  test("deep-merges a same-id feature's config rather than replacing it wholesale", () => {
    const parent: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {} as ServiceConfig,
      features: [{ id: "feat", config: { keep: 1, override: "parent" } }],
    };
    const child: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {} as ServiceConfig,
      features: [{ id: "feat", config: { override: "child", added: true } }],
    };

    const merged = mergeResolutionOverParent(parent, child);
    expect(merged.features.find((f) => f.id === "feat")?.config).toEqual({
      keep: 1,
      override: "child",
      added: true,
    });
  });

  test("merges logSources by id with child precedence", () => {
    const parent: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {} as ServiceConfig,
      features: [],
      logSources: [
        {
          id: "access" as never,
          path: "/var/log/parent/access.log" as never,
          stream: "stdout",
          strategy: "redirect",
          required: false,
          timestamps: false,
        },
        {
          id: "error" as never,
          path: "/var/log/parent/error.log" as never,
          stream: "stderr",
          strategy: "redirect",
          required: false,
          timestamps: false,
        },
      ],
    };
    const child: ServiceTypeResolution = {
      base: "lando",
      normalizedConfig: {} as ServiceConfig,
      features: [],
      logSources: [
        {
          id: "error" as never,
          path: "/var/log/child/error.log" as never,
          stream: "stderr",
          strategy: "follow",
          required: false,
          timestamps: false,
        },
        {
          id: "app" as never,
          path: "/app/logs/app.log" as never,
          stream: "stderr",
          strategy: "follow",
          required: false,
          timestamps: false,
        },
      ],
    };

    const merged = mergeResolutionOverParent(parent, child);
    expect(merged.logSources?.map((source) => String(source.id))).toEqual(["access", "error", "app"]);
    expect(String(merged.logSources?.find((source) => String(source.id) === "error")?.path)).toBe(
      "/var/log/child/error.log",
    );
    expect(merged.logSources?.find((source) => String(source.id) === "error")?.strategy).toBe("follow");
  });
});
