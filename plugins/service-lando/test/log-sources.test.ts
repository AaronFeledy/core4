import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { LandofileShape, type LogSource, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import { apacheServiceType } from "../src/services/apache.ts";
import { mariadbServiceType } from "../src/services/mariadb.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { nginxServiceType } from "../src/services/nginx.ts";
import { php83ServiceType } from "../src/services/php.ts";

const serviceFor = (type: string, via?: "apache" | "fpm" | "cli") => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: { type, ...(via === undefined ? {} : { via }) } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const resolveSources = async (
  serviceType: ServiceType,
  type: string,
  via?: "apache" | "fpm" | "cli",
): Promise<ReadonlyArray<LogSource>> => {
  const resolution = await Effect.runPromise(
    serviceType.resolve({
      name: "web",
      service: serviceFor(type, via),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      primary: true,
      metadata: {
        resolvedAt: "2026-05-18T08:00:00Z",
        source: "/srv/apps/myapp/.lando.yml",
        runtime: 4,
      },
    }),
  );
  return resolution.logSources ?? [];
};

const byId = (sources: ReadonlyArray<LogSource>, id: string): LogSource | undefined =>
  sources.find((source) => String(source.id) === id);

describe("catalog service type logSources", () => {
  test("apache declares access and error redirect sources", async () => {
    const sources = await resolveSources(apacheServiceType, "apache");

    expect(byId(sources, "access")).toMatchObject({ strategy: "redirect", stream: "stdout" });
    expect(String(byId(sources, "access")?.path)).toBe("/usr/local/apache2/logs/access_log");
    expect(byId(sources, "error")).toMatchObject({ strategy: "redirect", stream: "stderr" });
    expect(String(byId(sources, "error")?.path)).toBe("/usr/local/apache2/logs/error_log");
  });

  test("nginx declares access and error redirect sources", async () => {
    const sources = await resolveSources(nginxServiceType, "nginx");

    expect(byId(sources, "access")).toMatchObject({ strategy: "redirect", stream: "stdout" });
    expect(String(byId(sources, "access")?.path)).toBe("/var/log/nginx/access.log");
    expect(byId(sources, "error")).toMatchObject({ strategy: "redirect", stream: "stderr" });
    expect(String(byId(sources, "error")?.path)).toBe("/var/log/nginx/error.log");
  });

  test("php declares pathless Apache console aliases for its default serving mode", async () => {
    // Given the stock PHP service in its default Apache mode.
    // When resolving its declared log sources.
    const sources = await resolveSources(php83ServiceType, "php:8.3");

    // Then access and error select their native pipes without file-only fields.
    expect(sources.map(({ id, strategy, stream }) => ({ id: String(id), strategy, stream }))).toEqual([
      { id: "access", strategy: "console", stream: "stdout" },
      { id: "error", strategy: "console", stream: "stderr" },
    ]);
    for (const source of sources) {
      expect(source).not.toHaveProperty("path");
      expect(source).not.toHaveProperty("required");
      expect(source).not.toHaveProperty("timestamps");
    }
  });

  test("php declares pathless shared-stderr console aliases for via fpm", async () => {
    // Given the stock PHP service with via: fpm.
    // When resolving its declared log sources.
    const sources = await resolveSources(php83ServiceType, "php:8.3", "fpm");

    // Then both aliases select stderr without file-only fields.
    expect(sources.map(({ id, strategy, stream }) => ({ id: String(id), strategy, stream }))).toEqual([
      { id: "access", strategy: "console", stream: "stderr" },
      { id: "error", strategy: "console", stream: "stderr" },
    ]);
    for (const source of sources) {
      expect(source).not.toHaveProperty("path");
      expect(source).not.toHaveProperty("required");
      expect(source).not.toHaveProperty("timestamps");
    }
  });

  test("php via cli has no server log sources", async () => {
    expect(await resolveSources(php83ServiceType, "php:8.3", "cli")).toEqual([]);
  });

  test("mysql declares slow and general query follow sources only", async () => {
    const sources = await resolveSources(mysqlServiceType, "mysql");

    expect(sources.map((source) => String(source.id))).toEqual(["slow-query", "general-query"]);
    expect(sources.every((source) => source.strategy === "follow")).toBe(true);
  });

  test("mariadb declares slow and general query follow sources only", async () => {
    const sources = await resolveSources(mariadbServiceType, "mariadb");

    expect(sources.map((source) => String(source.id))).toEqual(["slow-query", "general-query"]);
    expect(sources.every((source) => source.strategy === "follow")).toBe(true);
  });
});
