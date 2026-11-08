import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService, Downloader } from "@lando/sdk/services";
import { testCaPem } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  type EngineCompositionInputs,
  type LandofileSourcePortRuntime,
  installEngineComposition,
} from "../../src/composition.ts";
import { scopedLandofileRuntimeInputs } from "../../src/services/landofile-live.ts";

describe("landofile network trust wiring", () => {
  test("scoped runtime captures resolveNetworkTrust from Effect context", async () => {
    const previous = globalThis.__landoEngineCompositionInputs;
    const seen: LandofileSourcePortRuntime[] = [];
    const unused = async (): Promise<never> => {
      throw new Error("unused source port");
    };
    const composition: EngineCompositionInputs = {
      bundledPluginModules: [],
      builtInCommandIds: [],
      landofileRuntimeInputs: {
        ports: {
          resolveUserCacheRoot: () => "/tmp/cache",
          resolveUserIncludesDir: () => "/tmp/includes",
          sources: {
            git: { fetch: unused },
            archive: { fetch: unused },
          },
        },
        templates: { modules: [] },
      },
      landofileSourcePorts: (_client, _downloader, runtime) => {
        if (runtime !== undefined) seen.push(runtime);
        return {
          sources: {
            git: { fetch: unused },
            archive: { fetch: unused },
          },
        };
      },
      hostProxyWorkerEntry: () => ({
        execPath: process.execPath,
        entryPath: undefined,
        bunSourceEntryPath: "/tmp/lando.ts",
      }),
      resolveContainerHelper: () => Effect.die("resolveContainerHelper should not run in this unit test"),
    };
    installEngineComposition(composition);

    const injected = {
      proxy: { https: "http://proxy.test:3128", noProxy: [] as const },
      caPems: ["unit-pem"],
      trustHost: false,
    };
    try {
      await Effect.runPromise(
        scopedLandofileRuntimeInputs.pipe(Effect.provideService(NetworkTrust, injected)),
      );
      expect(seen).toHaveLength(1);
      const resolve = seen[0]?.resolveNetworkTrust;
      expect(resolve).toBeTypeOf("function");
      if (typeof resolve !== "function") throw new Error("expected resolveNetworkTrust");
      expect(await resolve()).toEqual(injected);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "__landoEngineCompositionInputs");
      else installEngineComposition(previous);
    }
  });

  test("resolveNetworkTrust loads config CAs when NetworkTrust is unset", async () => {
    const previous = globalThis.__landoEngineCompositionInputs;
    const directory = await mkdtemp(join(tmpdir(), "lando-lf-trust-"));
    const caPath = join(directory, "ca.pem");
    const pem = testCaPem(0);
    await writeFile(caPath, pem, "utf-8");

    let resolveNetworkTrust: (() => Promise<unknown>) | undefined;
    const unused = async (): Promise<never> => {
      throw new Error("unused source port");
    };
    installEngineComposition({
      bundledPluginModules: [],
      builtInCommandIds: [],
      landofileRuntimeInputs: {
        ports: {
          resolveUserCacheRoot: () => "/tmp/cache",
          resolveUserIncludesDir: () => "/tmp/includes",
          sources: { git: { fetch: unused }, archive: { fetch: unused } },
        },
        templates: { modules: [] },
      },
      landofileSourcePorts: (_c, _d, runtime) => {
        resolveNetworkTrust = runtime?.resolveNetworkTrust;
        return { sources: { git: { fetch: unused }, archive: { fetch: unused } } };
      },
      hostProxyWorkerEntry: () => ({
        execPath: process.execPath,
        entryPath: undefined,
        bunSourceEntryPath: "/tmp/lando.ts",
      }),
      resolveContainerHelper: () => Effect.die("unused"),
    });

    const config = Schema.decodeUnknownSync(GlobalConfig)({
      network: { ca: { certs: [caPath], trustHost: false }, proxy: { http: "http://cfg:9" } },
    });
    const client = HttpClient.make((request) =>
      Effect.sync(() => HttpClientResponse.fromWeb(request, new Response("ok"))),
    );
    const downloader = Downloader.of({
      id: "test-downloader",
      capabilities: {
        schemes: ["https"],
        memoryDownload: false,
        cacheAware: false,
        offline: true,
        mirror: false,
      },
      download: () => Effect.die("unused"),
    });
    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: (key) => Effect.succeed(config[key]),
      }),
    );

    try {
      await Effect.runPromise(
        scopedLandofileRuntimeInputs.pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Downloader, downloader),
          Effect.provide(configLayer),
        ),
      );
      expect(resolveNetworkTrust).toBeTypeOf("function");
      if (typeof resolveNetworkTrust !== "function") throw new Error("expected resolveNetworkTrust");
      expect(await resolveNetworkTrust()).toEqual({
        proxy: { http: "http://cfg:9", noProxy: [] },
        caPems: [pem],
        trustHost: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
      if (previous === undefined) Reflect.deleteProperty(globalThis, "__landoEngineCompositionInputs");
      else installEngineComposition(previous);
    }
  });
});
