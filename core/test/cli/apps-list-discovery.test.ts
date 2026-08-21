import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { makeLandoPaths } from "@lando/paths";

import {
  appsFromContainerList,
  decodeAppliedStateFile,
  discoverRunningAppsFromSockets,
  mergeAppsListEntries,
} from "../../src/cli/commands/list-discovery.ts";
import { listServices, renderAppsListResult } from "../../src/cli/commands/list.ts";

const fakeConfigService = (dataRoot: string) =>
  Layer.succeed(ConfigService, {
    get: <K extends string>(key: K) =>
      Effect.succeed(key === "userDataRoot" ? (dataRoot as never) : (undefined as never)),
    getEffective: () => Effect.succeed({} as never),
  } as never);

const runList = (
  userDataRoot: string,
  options: {
    readonly userCacheRoot?: string;
    readonly discoverContainers?: (root: string) => Promise<ReadonlyArray<{ readonly appId: string }>>;
    readonly path?: string;
  } = {},
) =>
  Effect.runPromise(
    listServices({
      userDataRoot,
      userCacheRoot: options.userCacheRoot ?? userDataRoot,
      ...(options.discoverContainers === undefined ? {} : { discoverContainers: options.discoverContainers }),
      ...(options.path === undefined ? {} : { path: options.path }),
    }).pipe(Effect.provide(fakeConfigService(userDataRoot))),
  );

const stateEnvelope = (id: string, name: string, root: string, services: string[], provider = "lando") => ({
  version: 1,
  data: {
    id,
    name,
    root,
    provider,
    services: Object.fromEntries(services.map((service) => [service, { name: service }])),
  },
});

const labeled = (app: string, service: string, extra: Record<string, string> = {}) => ({
  Id: `${app}-${service}`,
  Names: [`/lando-${app}-${service}`],
  Labels: {
    "dev.lando.app": app,
    "dev.lando.service": service,
    ...extra,
  },
  State: "running",
});

const withTempRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-apps-list-discovery-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("decodeAppliedStateFile", () => {
  test("reads a plugin state-store AppPlan envelope", () => {
    const [entry] = decodeAppliedStateFile(
      JSON.stringify(stateEnvelope("drupal-cms", "Drupal CMS", "/srv/drupal-cms", ["appserver", "database"])),
      "lando",
    );
    expect(entry).toMatchObject({
      appId: "drupal-cms",
      appName: "Drupal CMS",
      providerId: "lando",
      appRoot: "/srv/drupal-cms",
      services: ["appserver", "database"],
    });
  });

  test("reads a podman applied-plans record", () => {
    const entries = decodeAppliedStateFile(
      JSON.stringify({
        version: 1,
        data: {
          alpha: stateEnvelope("alpha", "alpha", "/srv/alpha", ["web"], "podman").data,
          global: stateEnvelope("global", "global", "/var/lando/global", ["traefik", "mailpit"], "lando")
            .data,
        },
      }),
      "podman",
    );
    expect(entries.map((entry) => entry.appId).sort()).toEqual(["alpha", "global"]);
    expect(entries.find((entry) => entry.appId === "global")?.services).toEqual(["mailpit", "traefik"]);
  });

  test("still reads the legacy providers/*/apps envelope", () => {
    const [entry] = decodeAppliedStateFile(
      JSON.stringify({
        version: 1,
        providerId: "docker",
        plan: { id: "legacy", name: "legacy", root: "/srv/legacy", services: { web: {} } },
      }),
      "lando",
    );
    expect(entry).toMatchObject({ appId: "legacy", providerId: "docker", services: ["web"] });
  });
});

describe("appsFromContainerList", () => {
  test("groups running containers by dev.lando.app and includes the global app", () => {
    const apps = appsFromContainerList(
      [
        labeled("drupal-cms", "appserver", { "dev.lando.provider": "lando" }),
        labeled("drupal-cms", "database", { "dev.lando.provider": "lando" }),
        labeled("global", "traefik"),
        labeled("global", "mailpit"),
        labeled("scratchy", "web", { "dev.lando.scratch": "TRUE" }),
      ],
      { globalAppRoot: "/data/global" },
    );
    expect(apps.map((app) => app.appId).sort()).toEqual(["drupal-cms", "global"]);
    expect(apps.find((app) => app.appId === "drupal-cms")).toMatchObject({
      providerId: "lando",
      services: ["appserver", "database"],
      appRoot: "",
    });
    expect(apps.find((app) => app.appId === "global")).toMatchObject({
      appRoot: "/data/global",
      services: ["mailpit", "traefik"],
    });
  });
});

describe("mergeAppsListEntries", () => {
  test("unions services and prefers persisted roots over label-only rows", () => {
    const merged = mergeAppsListEntries([
      {
        appId: "drupal-cms",
        appName: "drupal-cms",
        providerId: "lando",
        appRoot: "/srv/drupal-cms",
        services: ["appserver"],
      },
      {
        appId: "drupal-cms",
        appName: "drupal-cms",
        providerId: "lando",
        appRoot: "",
        services: ["appserver", "database"],
      },
      {
        appId: "drupal-cms",
        appName: "drupal-cms",
        providerId: "cache",
        appRoot: "/srv/drupal-cms",
        services: [],
      },
    ]);
    expect(merged).toEqual([
      {
        appId: "drupal-cms",
        appName: "drupal-cms",
        providerId: "lando",
        appRoot: "/srv/drupal-cms",
        services: ["appserver", "database"],
      },
    ]);
  });
});

describe("apps:list host-wide discovery", () => {
  test("discovers applied apps from plugin state-store files", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const appliedDir = join(paths.pluginStateDir("@lando/provider-lando"), "applied-plans");
      await mkdir(appliedDir, { recursive: true });
      await writeFile(
        join(appliedDir, "drupal-cms.json"),
        JSON.stringify(
          stateEnvelope("drupal-cms", "drupal-cms", "/srv/drupal-cms", ["appserver", "database"]),
        ),
      );
      const result = await runList(userDataRoot, { discoverContainers: async () => [] });
      expect(result.apps).toEqual([
        {
          appId: "drupal-cms",
          appName: "drupal-cms",
          providerId: "lando",
          appRoot: "/srv/drupal-cms",
          services: ["appserver", "database"],
        },
      ]);
      expect(renderAppsListResult(result)).toContain("drupal-cms");
    });
  });

  test("discovers applied apps from the podman applied-plans record", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const pluginRoot = paths.pluginStateDir("@lando/provider-podman");
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        join(pluginRoot, "applied-plans.json"),
        JSON.stringify({
          version: 1,
          data: {
            blog: stateEnvelope("blog", "blog", "/srv/blog", ["nginx"], "podman").data,
          },
        }),
      );
      const result = await runList(userDataRoot, { discoverContainers: async () => [] });
      expect(result.apps).toEqual([
        {
          appId: "blog",
          appName: "blog",
          providerId: "podman",
          appRoot: "/srv/blog",
          services: ["nginx"],
        },
      ]);
    });
  });

  test("includes running labeled apps and the global app from any directory", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const result = await runList(userDataRoot, {
        discoverContainers: async () =>
          appsFromContainerList(
            [
              labeled("drupal-cms", "appserver", { "dev.lando.provider": "lando" }),
              labeled("drupal-cms", "database"),
              labeled("global", "traefik"),
              labeled("global", "mailpit"),
            ],
            { globalAppRoot: paths.globalAppRoot },
          ),
      });
      const names = result.apps.map((app) => app.appName);
      expect(names).toContain("drupal-cms");
      expect(names).toContain("global");
      expect(result.apps.find((app) => app.appId === "global")?.appRoot).toBe(paths.globalAppRoot);
      expect(result.apps.find((app) => app.appId === "drupal-cms")?.services).toEqual([
        "appserver",
        "database",
      ]);
    });
  });

  test("merges persisted plan roots with running container services", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const appliedDir = join(paths.pluginStateDir("@lando/provider-lando"), "applied-plans");
      await mkdir(appliedDir, { recursive: true });
      await writeFile(
        join(appliedDir, "drupal-cms.json"),
        JSON.stringify(stateEnvelope("drupal-cms", "drupal-cms", "/workspace/drupal-cms", ["appserver"])),
      );
      const result = await runList(userDataRoot, {
        discoverContainers: async () =>
          appsFromContainerList([labeled("drupal-cms", "appserver"), labeled("drupal-cms", "database")]),
      });
      expect(result.apps).toEqual([
        {
          appId: "drupal-cms",
          appName: "drupal-cms",
          providerId: "lando",
          appRoot: "/workspace/drupal-cms",
          services: ["appserver", "database"],
        },
      ]);
    });
  });

  test("discovers labeled containers from a Docker-compatible unix socket", async () => {
    await withTempRoot(async (userDataRoot) => {
      const socketPath = join(userDataRoot, "podman.sock");
      const server = createServer((request, response) => {
        if (request.url?.startsWith("/containers/json") !== true) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            labeled("drupal-cms", "appserver", { "dev.lando.provider": "lando" }),
            labeled("global", "traefik"),
          ]),
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => resolve());
        server.on("error", reject);
      });
      try {
        const discovered = await discoverRunningAppsFromSockets(userDataRoot, [socketPath]);
        expect(discovered.map((app) => app.appId).sort()).toEqual(["drupal-cms", "global"]);
        const result = await runList(userDataRoot, {
          discoverContainers: async (root) => discoverRunningAppsFromSockets(root, [socketPath]),
        });
        expect(result.apps.map((app) => app.appName)).toContain("drupal-cms");
        expect(result.apps.map((app) => app.appName)).toContain("global");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
