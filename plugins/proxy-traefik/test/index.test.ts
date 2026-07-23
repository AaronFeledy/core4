import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { AppId, ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { PathsService, ProxyService } from "@lando/sdk/services";
import { runProxyServiceContract } from "@lando/sdk/test";

import { makeLandoPaths } from "@lando/core/paths";
import { FileSystemLive } from "../../../core/src/services/file-system.ts";

import { PLUGIN_NAME, globalServices, manifest, proxy } from "../src/index.ts";

const withProxyService = async <T>(
  run: (input: {
    readonly root: string;
    readonly service: Context.Tag.Service<typeof ProxyService>;
  }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-proxy-traefik-"));
  try {
    const paths = makeLandoPaths({ userDataRoot: root, env: {}, platform: "linux" });
    const context = await Effect.runPromise(
      Layer.build(
        proxy.pipe(Layer.provide(Layer.merge(FileSystemLive, Layer.succeed(PathsService, paths)))),
      ).pipe(Effect.scoped),
    );
    const service = Context.getOption(context, ProxyService);
    if (Option.isNone(service)) throw new Error("ProxyService missing from proxy layer");
    return await run({ root, service: service.value });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("@lando/proxy-traefik plugin exports", () => {
  test("PLUGIN_NAME is the package name", () => {
    expect(PLUGIN_NAME).toBe("@lando/proxy-traefik");
  });

  test("proxy is a Layer", () => {
    expect(Layer.isLayer(proxy)).toBe(true);
  });

  test("proxy layer provides ProxyService", async () => {
    const paths = makeLandoPaths({ userDataRoot: "/tmp/lando-proxy-traefik-test", env: {} });
    const context = await Effect.runPromise(
      Layer.build(
        proxy.pipe(Layer.provide(Layer.merge(FileSystemLive, Layer.succeed(PathsService, paths)))),
      ).pipe(Effect.scoped),
    );

    const service = Context.getOption(context, ProxyService);
    expect(Option.isSome(service)).toBe(true);
  });

  test("proxy service satisfies the SDK contract", async () => {
    await withProxyService(async ({ service }) => {
      await Effect.runPromise(runProxyServiceContract(service));
    });
  });

  test("applyRoutes writes a Traefik TLS router for the app backend", async () => {
    await withProxyService(async ({ root, service }) => {
      await Effect.runPromise(
        service.applyRoutes(
          [
            {
              hostname: "app.example.test",
              scheme: "https",
              service: ServiceName.make("appserver"),
              endpoint: 8080,
            },
          ],
          AppId.make("example"),
        ),
      );

      const content = await readFile(
        join(root, "global", "proxy-traefik", "dynamic", "routes-example.yml"),
        "utf8",
      );
      expect(content).toContain("route-example-0-https:");
      expect(content).toContain("service: route-example-0");
      expect(content).toContain("route-example-0:");
      expect(content).toContain('rule: "Host(`app.example.test`)"');
      expect(content).toContain("entryPoints: [websecure]");
      expect(content).toContain("tls: {}");
      expect(content).toContain("url: http://appserver.example.internal:8080");
    });
  });

  test("applyRoutes renders both schemes and a path-prefix rule", async () => {
    await withProxyService(async ({ root, service }) => {
      await Effect.runPromise(
        service.applyRoutes(
          [
            {
              hostname: "app.example.test",
              scheme: "both",
              pathPrefix: "/admin",
              service: ServiceName.make("appserver"),
            },
          ],
          AppId.make("example"),
        ),
      );

      const content = await readFile(
        join(root, "global", "proxy-traefik", "dynamic", "routes-example.yml"),
        "utf8",
      );
      expect(content).toContain("route-example-0-http:");
      expect(content).toContain("route-example-0-https:");
      expect(content).toContain('rule: "Host(`app.example.test`) && PathPrefix(`/admin`)"');
      expect(content).toContain("url: http://appserver.example.internal:80");
    });
  });

  test("applyRoutes removes an existing route file when no routes remain", async () => {
    await withProxyService(async ({ root, service }) => {
      const appId = AppId.make("example");
      await Effect.runPromise(
        service.applyRoutes(
          [
            {
              hostname: "app.example.test",
              scheme: "https",
              service: ServiceName.make("appserver"),
            },
          ],
          appId,
        ),
      );

      await Effect.runPromise(service.applyRoutes([], appId));

      const routeFile = Bun.file(join(root, "global", "proxy-traefik", "dynamic", "routes-example.yml"));
      expect(await routeFile.exists()).toBe(false);
    });
  });

  test("removeRoutes is idempotent after removing an app route file", async () => {
    await withProxyService(async ({ root, service }) => {
      const appId = AppId.make("example");
      await Effect.runPromise(
        service.applyRoutes(
          [
            {
              hostname: "app.example.test",
              scheme: "https",
              service: ServiceName.make("appserver"),
              endpoint: 8080,
            },
          ],
          appId,
        ),
      );

      await Effect.runPromise(service.removeRoutes(appId));
      await Effect.runPromise(service.removeRoutes(appId));

      const routeFile = Bun.file(join(root, "global", "proxy-traefik", "dynamic", "routes-example.yml"));
      expect(await routeFile.exists()).toBe(false);
    });
  });

  test("manifest declares the traefik globalServices contribution", () => {
    expect(manifest.name).toBe("@lando/proxy-traefik");
    expect(manifest.api).toBe(4);
    const contributions = manifest.contributes?.globalServices ?? [];
    expect(contributions).toHaveLength(1);
    const traefik = contributions[0];
    expect(traefik?.id).toBe("traefik");
    expect(traefik?.module).toBe("./src/global-services/traefik.ts");
    expect(traefik?.enabledByDefault).toBe(true);
    expect(traefik?.requires?.providerCapabilities).toEqual(["sharedCrossAppNetwork"]);
    expect(traefik?.summary).toBe("Global Traefik reverse proxy");
  });

  test("manifest declares the traefik proxy contribution", () => {
    expect(manifest.contributes?.proxies).toEqual(["traefik"]);
  });

  test("globalServices map yields the traefik ServiceConfig effect", async () => {
    expect(globalServices).toBeInstanceOf(Map);
    const traefikEffect = globalServices.get("traefik");
    expect(traefikEffect).toBeDefined();
    if (traefikEffect === undefined) throw new Error("traefik effect missing");
    expect(Effect.isEffect(traefikEffect)).toBe(true);
    const config = Schema.decodeUnknownSync(ServiceConfig)(await Effect.runPromise(traefikEffect));
    expect(config.type).toBe("compose");
    expect(config.image).toBe("traefik:v3.3");
    expect(config.mounts).toEqual([
      {
        type: "bind",
        source: expect.stringContaining("proxy-traefik"),
        target: "/etc/traefik/dynamic",
        readOnly: false,
      },
    ]);
  });
});
