import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { makeTestRuntime } from "@lando/core/testing";
import { composePath, emitCompose, renderCompose } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const appId = AppId.make("myapp");
const appRoot = AbsolutePath.make("/srv/apps/myapp");
const userDataRoot = AbsolutePath.make("/tmp/lando-data");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "compose-emit.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: {
    kind: "ref",
    ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine",
  },
  environment: name === "web" ? { NODE_ENV: "development" } : { POSTGRES_PASSWORD: "lando" },
  appMount:
    name === "web"
      ? {
          source: appRoot,
          target: PortablePath.make("/app"),
          readOnly: false,
          excludes: ["node_modules"],
          includes: [],
          realization: "passthrough",
        }
      : undefined,
  mounts:
    name === "web"
      ? [
          {
            type: "bind",
            source: "/srv/shared/config",
            target: PortablePath.make("/config"),
            readOnly: true,
            realization: "passthrough",
          },
        ]
      : [],
  storage:
    name === "database"
      ? [
          {
            store: "myapp_database_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "web"
      ? [
          { port: 3000, protocol: "http", name: "http" },
          { port: 9229, protocol: "tcp", name: "debug" },
        ]
      : [{ port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "web" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const database = servicePlan("database");
const web = servicePlan("web");

const plan: AppPlan = {
  id: appId,
  name: "My App",
  slug: "myapp",
  root: appRoot,
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [{ name: "myapp_default", shared: false, driver: "bridge" }],
  stores: [{ name: "myapp_database_data", scope: "service" }],
  metadata,
  extensions: {},
};

const topLevelKeys = (content: string): string[] =>
  content
    .split("\n")
    .filter((line) => /^[a-z]/u.test(line))
    .map((line) => line.slice(0, line.indexOf(":")));

const serviceKeys = (content: string, service: string): string[] => {
  const lines = content.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z]/u.test(line));
  const section = lines.slice(start + 1, end === -1 ? lines.length : end);

  return section
    .filter((line) => /^ {4}[a-z_]+:/u.test(line))
    .map((line) => line.trim().slice(0, line.trim().indexOf(":")));
};

describe("provider-lando Compose emission", () => {
  test("renders AppPlan services, networks, volumes, and ports as Compose v3 YAML", () => {
    const content = renderCompose(plan);

    expect(content).toStartWith('version: "3.9"\nservices:\n');
    expect(content).toContain("  web:\n");
    expect(content).toContain('    image: "node:22-alpine"\n');
    expect(content).toContain('      - "3000:3000"\n');
    expect(content).toContain('      - "9229:9229"\n');
    expect(content).toContain('      NODE_ENV: "development"\n');
    expect(content).toContain('      - "/srv/apps/myapp:/app"\n');
    expect(content).toContain('      - "/srv/shared/config:/config:ro"\n');
    expect(content).toContain('      - "database"\n');
    expect(content).toContain("  database:\n");
    expect(content).toContain('    image: "postgres:16-alpine"\n');
    expect(content).toContain('      - "5432:5432"\n');
    expect(content).toContain('      POSTGRES_PASSWORD: "lando"\n');
    expect(content).toContain('      - "myapp_database_data:/var/lib/postgresql/data"\n');
    expect(content).toContain("networks:\n");
    expect(content).toContain("  myapp_default:\n");
    expect(content).toContain('    driver: "bridge"\n');
    expect(content).toContain("volumes:\n  myapp_database_data:\n");
  });

  test("keeps Compose output inside the MVP key allowlist", () => {
    const content = renderCompose(plan);

    expect(topLevelKeys(content).sort()).toEqual(["networks", "services", "version", "volumes"]);
    expect(serviceKeys(content, "web").sort()).toEqual([
      "depends_on",
      "environment",
      "image",
      "networks",
      "ports",
      "volumes",
    ]);
    expect(serviceKeys(content, "database").sort()).toEqual([
      "environment",
      "image",
      "networks",
      "ports",
      "volumes",
    ]);
    expect(content).not.toContain("deploy:");
    expect(content).not.toContain("secrets:");
    expect(content).not.toContain("configs:");
  });

  test("writes compose.yml through FileSystem under the per-app data directory", async () => {
    const runtime = makeTestRuntime();
    const result = await Effect.runPromise(
      emitCompose(plan, { userDataRoot }).pipe(Effect.provide(runtime.layer)),
    );

    expect(result.path).toBe("/tmp/lando-data/apps/myapp/compose.yml");
    expect(composePath(plan, { userDataRoot })).toBe(result.path);
    expect(runtime.files.get(result.path)).toBe(result.content);
    expect(runtime.calls.fileSystem).toContainEqual({
      operation: "writeAtomic",
      path: result.path,
      content: result.content,
    });
    expect(
      runtime.calls.fileSystem.some((call) => call.operation === "write" || call.operation === "writeFile"),
    ).toBe(false);
  });
});
