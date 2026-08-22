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
          {
            _tag: "published",
            port: 3000,
            protocol: "http",
            name: "http",
            publication: { hostPort: 3000 },
          },
          { _tag: "internal", port: 9229, protocol: "tcp", name: "debug" },
        ]
      : [{ _tag: "internal", port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn:
    name === "web"
      ? [{ service: ServiceName.make("database"), condition: "service_started", required: true }]
      : [],
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
  stores: [
    { name: "myapp_database_data", scope: "service", kind: "data" },
    { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" },
  ],
  fileSync: [],
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
    expect(content).toContain('      - "127.0.0.1:3000:3000"\n');
    expect(content).toContain('    expose:\n      - "9229"\n');
    expect(content).toContain('      NODE_ENV: "development"\n');
    expect(content).toContain('      - "/srv/apps/myapp:/app"\n');
    expect(content).toContain('      - "/srv/shared/config:/config:ro"\n');
    expect(content).toContain('      database:\n        condition: "service_started"\n');
    expect(content).toContain("  database:\n");
    expect(content).toContain('    image: "postgres:16-alpine"\n');
    expect(content).toContain('    expose:\n      - "5432"\n');
    expect(content).toContain('      POSTGRES_PASSWORD: "lando"\n');
    expect(content).toContain('      - "myapp_database_data:/var/lib/postgresql/data"\n');
    expect(content).toContain("networks:\n");
    expect(content).toContain("  lando-myapp:\n");
    expect(content).toContain('    driver: "bridge"\n');
    expect(content).toContain("volumes:\n  myapp_database_data:\n");
    expect(content).toContain(
      '  lando-cache-npm:\n    labels:\n      dev.lando.app: "myapp"\n      dev.lando.provider: "lando"\n      dev.lando.scope: "global"\n      dev.lando.storage-kind: "cache"\n      dev.lando.store: "lando-cache-npm"\n',
    );
  });

  test("renders preserved user labels on services", () => {
    const labeledWeb: ServicePlan = {
      ...web,
      extensions: { compose: { labels: { "example.com/role": "web", "dev.lando.app": "user-value" } } },
    };
    const content = renderCompose({
      ...plan,
      services: { [labeledWeb.name]: labeledWeb, [database.name]: database },
    });

    expect(content).toContain(
      '    labels:\n      dev.lando.app: "myapp"\n      dev.lando.service: "web"\n      example.com/role: "web"\n',
    );
  });

  test("renders Compose config grants as read-only bind volumes", () => {
    const webWithConfigs: ServicePlan = {
      ...web,
      extensions: {
        compose: {
          configs: [
            { source: "phpini" },
            { source: "phpini", target: "/usr/local/etc/php/conf.d/zz-custom.ini" },
          ],
        },
      },
    };
    const content = renderCompose({
      ...plan,
      services: { [webWithConfigs.name]: webWithConfigs, [database.name]: database },
      extensions: {
        compose: {
          configs: {
            phpini: { file: "./php.ini" },
          },
        },
      },
    });

    expect(content).toContain('      - "/srv/apps/myapp:/app"\n');
    expect(content).toContain('      - "/srv/shared/config:/config:ro"\n');
    expect(content).toContain('      - "/srv/apps/myapp/php.ini:/phpini:ro"\n');
    expect(content).toContain(
      '      - "/srv/apps/myapp/php.ini:/usr/local/etc/php/conf.d/zz-custom.ini:ro"\n',
    );
    expect(content).not.toContain("configs:");
  });

  test("keeps Compose output inside the MVP key allowlist", () => {
    const content = renderCompose(plan);

    expect(topLevelKeys(content).sort()).toEqual(["networks", "services", "version", "volumes"]);
    expect(serviceKeys(content, "web").sort()).toEqual([
      "depends_on",
      "environment",
      "expose",
      "image",
      "labels",
      "networks",
      "ports",
      "volumes",
    ]);
    expect(serviceKeys(content, "database").sort()).toEqual([
      "environment",
      "expose",
      "image",
      "labels",
      "networks",
      "volumes",
    ]);
    expect(content).not.toContain("deploy:");
    expect(content).not.toContain("secrets:");
    expect(content).not.toContain("configs:");
  });

  test("depends_on condition healthy maps to service_healthy in Compose long-form", () => {
    const healthyWeb: ServicePlan = {
      ...web,
      dependsOn: [{ service: ServiceName.make("database"), condition: "service_healthy", required: true }],
    };
    const content = renderCompose({
      ...plan,
      services: { [healthyWeb.name]: healthyWeb, [database.name]: database },
    });

    expect(content).toContain('      database:\n        condition: "service_healthy"\n');
    expect(content).toContain('    depends_on:\n      database:\n        condition: "service_healthy"\n');
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

    expect(content).toContain('    tmpfs:\n      - "/tmp/cache"\n');

    const lines = content.split("\n");
    const volumesIdx = lines.findIndex((l) => l === "    volumes:");
    const nextSectionIdx = lines.findIndex((l, i) => i > volumesIdx && /^ {4}[a-z]/u.test(l));
    const volumesLines = lines.slice(volumesIdx + 1, nextSectionIdx === -1 ? lines.length : nextSectionIdx);
    expect(volumesLines.every((l) => !l.includes("/tmp/cache"))).toBe(true);
  });

  test("uses long volume syntax only for subpath and disabled bind path creation", () => {
    const webWithMountOptions: ServicePlan = {
      ...web,
      mounts: [
        ...web.mounts,
        {
          type: "bind",
          source: "/srv/existing/config",
          target: PortablePath.make("/existing-config"),
          readOnly: false,
          createHostPath: false,
          realization: "passthrough",
        },
        {
          type: "bind",
          source: "/srv/synced",
          target: PortablePath.make("/synced"),
          readOnly: false,
          createHostPath: false,
          realization: "accelerated",
        },
      ],
    };
    const databaseWithSubpath: ServicePlan = {
      ...database,
      storage: [
        {
          store: "myapp_database_data",
          target: PortablePath.make("/var/lib/postgresql/data"),
          readOnly: true,
          subpath: "tenant",
        },
      ],
    };

    const content = renderCompose({
      ...plan,
      services: {
        [webWithMountOptions.name]: webWithMountOptions,
        [databaseWithSubpath.name]: databaseWithSubpath,
      },
    });

    expect(content).toContain('      - "/srv/apps/myapp:/app"\n');
    expect(content).toContain('      - "/srv/shared/config:/config:ro"\n');
    expect(content).toContain('      - "My-App-web-mount-2:/synced"\n');
    expect(content).toContain(
      '      - type: "bind"\n        source: "/srv/existing/config"\n        target: "/existing-config"\n        read_only: false\n        bind:\n          create_host_path: false\n',
    );
    expect(content).toContain(
      '      - type: "volume"\n        source: "myapp_database_data"\n        target: "/var/lib/postgresql/data"\n        read_only: true\n        volume:\n          subpath: "tenant"\n',
    );
    expect(content).not.toContain('      - "/srv/existing/config:/existing-config"\n');
    expect(content).not.toContain('      - "myapp_database_data:/var/lib/postgresql/data:ro"\n');
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
    expect(
      runtime.calls.fileSystem.some((call) => call.operation === "write" || call.operation === "writeFile"),
    ).toBe(false);
  });

  test("pathJoin preserves leading slash including root-only input", () => {
    expect(composePath(plan, { userDataRoot: "/data" })).toBe("/data/apps/myapp/compose.yml");
    expect(composePath(plan, { userDataRoot: "/data/" })).toBe("/data/apps/myapp/compose.yml");

    const content = renderCompose(plan);
    const volumeLines = content.split("\n").filter((line) => /^ {6}- "\//.test(line));
    expect(volumeLines.length).toBeGreaterThan(0);
  });

  test("renders typed NetworkingPlan custom shared network membership", () => {
    const content = renderCompose({
      ...plan,
      networking: {
        perAppBridge: { name: "custom-app-net", driver: "bridge" },
        sharedNetworkMembership: {
          name: "custom-shared-net",
          aliases: { [web.name]: ["web.custom.internal"] },
        },
      },
    });

    expect(content).toContain("      custom-app-net:\n");
    expect(content).toContain(
      '      custom-shared-net:\n        aliases:\n          - "web.custom.internal"',
    );
    expect(content).toContain('  custom-app-net:\n    driver: "bridge"');
    expect(content).toContain('  custom-shared-net:\n    external: true\n    name: "custom-shared-net"');
    expect(content).not.toContain("lando_bridge_network");
  });

  test("omits shared compose network for per-app-only NetworkingPlan", () => {
    const content = renderCompose({
      ...plan,
      networking: { perAppBridge: { name: "custom-app-net", driver: "bridge" } },
    });

    expect(content).toContain("      custom-app-net:\n");
    expect(content).toContain('  custom-app-net:\n    driver: "bridge"');
    expect(content).toContain("aliases:");
    expect(content).not.toContain("lando_bridge_network");
  });
});
