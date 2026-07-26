import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  LandofileShape,
  ServiceConfig,
  ServiceConfigInput,
  ServiceDependency,
} from "../../src/schema/index.ts";

// US-468 — Compose spellings & alternate scalar/list forms.
// The user-facing Landofile boundary decodes through LandofileShape.services
// (which wraps ServiceConfigInput -> ServiceConfig). ServiceConfig itself
// canonicalizes the per-key alternate forms for direct decoders.

const decodeService = (raw: unknown): ServiceConfig => Schema.decodeUnknownSync(ServiceConfig)(raw);

const decodeAuthored = (service: Record<string, unknown>): ServiceConfig => {
  const shape = Schema.decodeUnknownSync(LandofileShape)(
    { name: "app", services: { web: service } },
    { onExcessProperty: "error" },
  );
  const web = shape.services?.web;
  if (web === undefined) throw new Error("missing web service");
  return web;
};

describe("ServiceConfig compose spellings & alternate forms (US-468)", () => {
  describe("environment", () => {
    test("KEY=value list form canonicalizes to a map", () => {
      expect(decodeService({ environment: ["NODE_ENV=development", "PORT=3000"] }).environment).toEqual({
        NODE_ENV: "development",
        PORT: "3000",
      });
    });

    test("map form is preserved", () => {
      expect(decodeService({ environment: { NODE_ENV: "development" } }).environment).toEqual({
        NODE_ENV: "development",
      });
    });

    test("bare list entry without '=' fails with KEY=value remediation", () => {
      const result = Schema.decodeUnknownEither(ServiceConfig)({ environment: ["NODE_ENV"] });
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(String(result.left)).toContain("KEY=value");
      }
    });
  });

  describe("labels", () => {
    test("map form canonicalizes", () => {
      expect(decodeService({ labels: { "com.example.tier": "web" } }).labels).toEqual({
        "com.example.tier": "web",
      });
    });

    test("KEY=value list form canonicalizes; bare entry becomes empty string", () => {
      expect(decodeService({ labels: ["com.example.tier=web", "bare"] }).labels).toEqual({
        "com.example.tier": "web",
        bare: "",
      });
    });
  });

  describe("dependsOn", () => {
    test("string list canonicalizes to structured entries", () => {
      expect(decodeService({ dependsOn: ["database", "cache"] }).dependsOn).toEqual([
        { service: "database" },
        { service: "cache" },
      ]);
    });

    test("condition-map form canonicalizes, preserving condition/required/restart", () => {
      expect(
        decodeService({
          dependsOn: {
            database: { condition: "service_healthy", required: false, restart: true },
          },
        }).dependsOn,
      ).toEqual([{ service: "database", condition: "service_healthy", required: false, restart: true }]);
    });
  });

  describe("envFile", () => {
    test("string form canonicalizes to a list", () => {
      expect(decodeService({ envFile: "./.env" }).envFile).toEqual(["./.env"]);
    });

    test("list form is preserved", () => {
      expect(decodeService({ envFile: ["./.env", "./.env.local"] }).envFile).toEqual([
        "./.env",
        "./.env.local",
      ]);
    });
  });

  describe("Compose cross-key spellings via Landofile boundary (Lando key wins)", () => {
    test("working_dir decodes to workingDirectory", () => {
      expect(decodeAuthored({ working_dir: "/app" }).workingDirectory).toBe("/app");
    });

    test("workingDirectory wins over working_dir when both present", () => {
      expect(decodeAuthored({ working_dir: "/compose", workingDirectory: "/lando" }).workingDirectory).toBe(
        "/lando",
      );
    });

    test("depends_on string-list decodes to structured dependsOn", () => {
      expect(decodeAuthored({ depends_on: ["database"] }).dependsOn).toEqual([{ service: "database" }]);
    });

    test("depends_on condition-map decodes and preserves condition", () => {
      expect(
        decodeAuthored({ depends_on: { database: { condition: "service_completed_successfully" } } })
          .dependsOn,
      ).toEqual([{ service: "database", condition: "service_completed_successfully" }]);
    });

    test("dependsOn wins over depends_on when both present", () => {
      expect(decodeAuthored({ depends_on: ["compose"], dependsOn: ["lando"] }).dependsOn).toEqual([
        { service: "lando" },
      ]);
    });

    test("env_file decodes to envFile", () => {
      expect(decodeAuthored({ env_file: ["./.env"] }).envFile).toEqual(["./.env"]);
    });
  });

  describe("rejected sub-forms", () => {
    test("env_file long-object form is rejected", () => {
      const result = Schema.decodeUnknownEither(ServiceConfigInput)(
        { env_file: { path: "./.env", required: false } },
        { onExcessProperty: "error" },
      );
      expect(Either.isLeft(result)).toBe(true);
    });

    test("depends_on entry extension (x-*) is rejected", () => {
      const result = Schema.decodeUnknownEither(ServiceConfigInput)(
        { depends_on: { database: { condition: "service_healthy", "x-lando": true } } },
        { onExcessProperty: "error" },
      );
      expect(Either.isLeft(result)).toBe(true);
    });
  });

  describe("ServiceDependency schema is exported and canonical", () => {
    test("decodes a full entry", () => {
      expect(
        Schema.decodeUnknownSync(ServiceDependency)({
          service: "db",
          condition: "service_healthy",
          required: true,
          restart: false,
        }),
      ).toEqual({ service: "db", condition: "service_healthy", required: true, restart: false });
    });
  });
});
