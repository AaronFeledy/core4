import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";

import { ConfigService } from "@lando/sdk/services";

import { makeLandoPaths } from "@lando/paths";

import {
  type AppsListEntry,
  appsFromContainerList,
  containerSocketCandidates,
  decodeAppliedStateFile,
  discoverRunningAppsFromSockets,
  isNamedPipeSocketPath,
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
    readonly discoverContainers?: (root: string) => Promise<ReadonlyArray<AppsListEntry>>;
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

const withClearedDockerHost = <T>(run: () => T): T => {
  const previousDockerHost = process.env.DOCKER_HOST;
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  Reflect.deleteProperty(process.env, "DOCKER_HOST");
  Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR");
  try {
    return run();
  } finally {
    if (previousDockerHost === undefined) Reflect.deleteProperty(process.env, "DOCKER_HOST");
    else process.env.DOCKER_HOST = previousDockerHost;
    if (previousRuntime === undefined) Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR");
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
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

  test("skips stopped leftovers so the running claim stays honest", () => {
    const apps = appsFromContainerList([
      labeled("live", "web"),
      { ...labeled("dead", "web"), State: "exited" },
    ]);
    expect(apps.map((app) => app.appId)).toEqual(["live"]);
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

  test("keeps the first nonempty plugin root over a longer leftover path", () => {
    const merged = mergeAppsListEntries([
      {
        appId: "drupal-cms",
        appName: "Drupal CMS",
        providerId: "lando",
        appRoot: "/srv/app",
        services: ["appserver"],
      },
      {
        appId: "drupal-cms",
        appName: "stale",
        providerId: "docker",
        appRoot: "/very/long/stale/legacy/path/to/app",
        services: ["database"],
      },
    ]);
    expect(merged).toEqual([
      {
        appId: "drupal-cms",
        appName: "Drupal CMS",
        providerId: "lando",
        appRoot: "/srv/app",
        services: ["appserver", "database"],
      },
    ]);
  });
});

describe("apps:list host-wide discovery", () => {
  test("prefers plugin applied-plans over leftover legacy providers/*/apps for the same appId", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const appliedDir = join(paths.pluginStateDir("@lando/provider-lando"), "applied-plans");
      await mkdir(appliedDir, { recursive: true });
      await writeFile(
        join(appliedDir, "drupal-cms.json"),
        JSON.stringify(stateEnvelope("drupal-cms", "Drupal CMS", "/srv/drupal-cms", ["appserver"], "lando")),
      );
      const legacyDir = join(userDataRoot, "providers", "provider-lando", "apps");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "drupal-cms.json"),
        JSON.stringify(
          stateEnvelope(
            "drupal-cms",
            "stale-name",
            "/very/long/stale/legacy/drupal-cms",
            ["database"],
            "docker",
          ),
        ),
      );
      const result = await runList(userDataRoot, { discoverContainers: async () => [] });
      expect(result.apps).toEqual([
        {
          appId: "drupal-cms",
          appName: "Drupal CMS",
          providerId: "lando",
          appRoot: "/srv/drupal-cms",
          services: ["appserver", "database"],
        },
      ]);
    });
  });

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

  test("discovers applied apps from the docker plugin applied-plans directory", async () => {
    await withTempRoot(async (userDataRoot) => {
      const paths = makeLandoPaths({ userDataRoot });
      const appliedDir = join(paths.pluginStateDir("@lando/provider-docker"), "applied-plans");
      await mkdir(appliedDir, { recursive: true });
      await writeFile(
        join(appliedDir, "blog.json"),
        JSON.stringify(stateEnvelope("blog", "blog", "/srv/blog", ["nginx"], "docker")),
      );
      const result = await runList(userDataRoot, { discoverContainers: async () => [] });
      expect(result.apps).toEqual([
        {
          appId: "blog",
          appName: "blog",
          providerId: "docker",
          appRoot: "/srv/blog",
          services: ["nginx"],
        },
      ]);
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
      let requestUrl: string | undefined;
      const server = createServer((request, response) => {
        requestUrl = request.url;
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
        expect(requestUrl).toBeDefined();
        expect(requestUrl?.includes("all=true")).toBe(false);
        expect(requestUrl?.includes("running")).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  test("stops at the first successful socket and does not query later host sockets", async () => {
    await withTempRoot(async (userDataRoot) => {
      const firstPath = join(userDataRoot, "managed.sock");
      const secondPath = join(userDataRoot, "host.sock");
      const hits: string[] = [];
      const listen = async (socketPath: string, appId: string) => {
        const server = createServer((_request, response) => {
          hits.push(socketPath);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify([labeled(appId, "web", { "dev.lando.provider": "lando" })]));
        });
        await new Promise<void>((resolve, reject) => {
          server.listen(socketPath, () => resolve());
          server.on("error", reject);
        });
        return server;
      };
      const first = await listen(firstPath, "managed-app");
      const second = await listen(secondPath, "host-app");
      try {
        const discovered = await discoverRunningAppsFromSockets(userDataRoot, [firstPath, secondPath]);
        expect(discovered.map((app) => app.appId)).toEqual(["managed-app"]);
        expect(hits).toEqual([firstPath]);
      } finally {
        await new Promise<void>((resolve) => first.close(() => resolve()));
        await new Promise<void>((resolve) => second.close(() => resolve()));
      }
    });
  });

  test("skips filesystem access for named-pipe candidates and still stops at the first successful socket", async () => {
    await withTempRoot(async (userDataRoot) => {
      const pipePath = "\\\\.\\pipe\\podman-lando";
      const unixPath = join(userDataRoot, "host.sock");
      expect(isNamedPipeSocketPath(pipePath)).toBe(true);
      const hits: string[] = [];
      const server = createServer((_request, response) => {
        hits.push(unixPath);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify([labeled("managed-app", "web", { "dev.lando.provider": "lando" })]));
      });
      await new Promise<void>((resolve, reject) => {
        server.listen(unixPath, () => resolve());
        server.on("error", reject);
      });
      try {
        const discovered = await discoverRunningAppsFromSockets(userDataRoot, [pipePath, unixPath]);
        expect(discovered.map((app) => app.appId)).toEqual(["managed-app"]);
        expect(hits).toEqual([unixPath]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

describe("containerSocketCandidates", () => {
  test("prefers the managed provider socket and does not default to host docker.sock", () => {
    withClearedDockerHost(() => {
      const candidates = containerSocketCandidates("/iso/data");
      expect(candidates[0]).toBe(makeLandoPaths({ userDataRoot: "/iso/data" }).providerSocketPath);
      expect(candidates).not.toContain("/var/run/docker.sock");
    });
  });

  test("win32 candidates include the managed named pipe first and do not default to host docker", () => {
    withClearedDockerHost(() => {
      const candidates = containerSocketCandidates("/iso/data", { platform: "win32" });
      expect(candidates[0]).toBe("\\\\.\\pipe\\podman-lando");
      expect(candidates).not.toContain("/var/run/docker.sock");
      expect(candidates).not.toContain("\\\\.\\pipe\\docker_engine");
      expect(candidates).not.toContain(makeLandoPaths({ userDataRoot: "/iso/data" }).providerSocketPath);
    });
  });

  test("accepts npipe DOCKER_HOST values and converts them to a Node socketPath", () => {
    withClearedDockerHost(() => {
      process.env.DOCKER_HOST = "npipe://./pipe/podman-machine-default";
      const fromShort = containerSocketCandidates("/iso/data", { platform: "win32" });
      expect(fromShort[0]).toBe("\\\\.\\pipe\\podman-lando");
      expect(fromShort).toContain("\\\\.\\pipe\\podman-machine-default");
      expect(fromShort).not.toContain("/var/run/docker.sock");
      expect(fromShort).not.toContain("\\\\.\\pipe\\docker_engine");

      process.env.DOCKER_HOST = "npipe:////./pipe/docker_engine";
      const fromLong = containerSocketCandidates("/iso/data", { platform: "win32" });
      expect(fromLong[0]).toBe("\\\\.\\pipe\\podman-lando");
      expect(fromLong).toContain("\\\\.\\pipe\\docker_engine");
    });
  });
});
