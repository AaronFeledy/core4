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
    // depends_on uses long-form object with condition (not short-form string list)
    expect(content).toContain('      database:\n        condition: "service_started"\n');
    expect(content).toContain("  database:\n");
    expect(content).toContain('    image: "postgres:16-alpine"\n');
    expect(content).toContain('      - "5432:5432"\n');
    expect(content).toContain('      POSTGRES_PASSWORD: "lando"\n');
    expect(content).toContain('      - "myapp_database_data:/var/lib/postgresql/data"\n');
    expect(content).toContain("networks:\n");
    expect(content).toContain("  lando-myapp:\n");
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

  test("depends_on condition healthy maps to service_healthy in Compose long-form", () => {
    const healthyWeb: ServicePlan = {
      ...web,
      dependsOn: [{ service: ServiceName.make("database"), condition: "healthy" }],
    };
    const content = renderCompose({
      ...plan,
      services: { [healthyWeb.name]: healthyWeb, [database.name]: database },
    });

    expect(content).toContain('      database:\n        condition: "service_healthy"\n');
    // Must NOT use the old short-form string list syntax
    expect(content).not.toContain('      - "database"');
  });

  test("tmpfs mounts appear under tmpfs: key, not in volumes: list", () => {
    const webWithTmpfs: ServicePlan = {
      ...web,
      mounts: [
        ...web.mounts,
        {
          type: "tmpfs",
          source: undefined,
          target: PortablePath.make("/tmp/cache"),
          readOnly: false,
          realization: "passthrough",
        },
      ],
    };
    const content = renderCompose({
      ...plan,
      services: { [webWithTmpfs.name]: webWithTmpfs, [database.name]: database },
    });

    // Should appear under the tmpfs: key
    expect(content).toContain('    tmpfs:\n      - "/tmp/cache"\n');

    // Must NOT appear as a bare anonymous volume entry in the volumes: list.
    // Volumes list entries always have source:target format, so a bare path
    // means it was incorrectly placed there.
    const lines = content.split("\n");
    const volumesIdx = lines.findIndex((l) => l === "    volumes:");
    const nextSectionIdx = lines.findIndex((l, i) => i > volumesIdx && /^ {4}[a-z]/u.test(l));
    const volumesLines = lines.slice(volumesIdx + 1, nextSectionIdx === -1 ? lines.length : nextSectionIdx);
    expect(volumesLines.every((l) => !l.includes("/tmp/cache"))).toBe(true);
  });

  test("writes compose.yml through FileSystem under the per-app data directory", async () => {
    const runtime = makeTestRuntime();
    const result = await Effect.runPromise(
      emitCompose(plan, { userDataRoot }).pipe(Effect.provide(runtime.layer)),
    );

    expect(result.path).toBe("/tmp/lando-data/apps/myapp/compose.yml");
    expect(composePath(plan, { userDataRoot })).toBe("/tmp/lando-data/apps/myapp/compose.yml");
    expect(result.content).toStartWith('version: "3.9"\n');
    expect(runtime.calls.fileSystem.some((call) => call.operation === "mkdir")).toBe(true);
    expect(runtime.calls.fileSystem.some((call) => call.operation === "writeAtomic")).toBe(true);
    // Must not use raw write/writeFile (should go through writeAtomic)
    expect(
      runtime.calls.fileSystem.some((call) => call.operation === "write" || call.operation === "writeFile"),
    ).toBe(false);
  });

  test("pathJoin preserves leading slash including root-only input", () => {
    // Verify composePath always produces absolute paths
    expect(composePath(plan, { userDataRoot: "/data" })).toBe("/data/apps/myapp/compose.yml");
    expect(composePath(plan, { userDataRoot: "/data/" })).toBe("/data/apps/myapp/compose.yml");

    // All volume mount paths in the rendered output should be absolute
    const content = renderCompose(plan);
    const volumeLines = content.split("\n").filter((line) => /^ {6}- "\//.test(line));
    expect(volumeLines.length).toBeGreaterThan(0);
  });
});
