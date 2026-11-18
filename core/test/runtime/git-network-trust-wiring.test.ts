import { expect, test } from "bun:test";
import { BuildSourceStore } from "@lando/engine/services/build-source-store";
import { layer as downloaderLayer } from "@lando/http-client/downloader";
import { layerWith } from "@lando/http-client/live";
import { NetworkTrust } from "@lando/http-client/network-trust";
import type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
import { ProcessRunner, type ProcessSpawnOptions, StateStore } from "@lando/sdk/services";
import { makeTestProcessRunner, withTestSources } from "@lando/source-acquisition/testing";
import { Effect, Layer } from "effect";
import { retainedSourceTransports } from "../../src/recipes/runtime-sources.ts";
import { baseEngineCompositionInputs, buildSourceStoreLayer } from "../../src/runtime/engine-composition.ts";

test.each(["landofile", "recipe"])("%s composition projects resolved trust into git", async (owner) => {
  const observed: ProcessSpawnOptions[] = [];
  const commit = "a".repeat(40);
  const runner = {
    ...makeTestProcessRunner(),
    run: (input: ProcessSpawnOptions) => {
      observed.push(input);
      return Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD`, stderr: "" });
    },
  };
  const trust: ResolvedNetworkTrust = {
    proxy: { https: "http://resolved-proxy.test:3128", noProxy: [] },
    caPems: [],
    trustHost: true,
  };
  const transports =
    owner === "landofile"
      ? baseEngineCompositionInputs.landofileSourcePorts(undefined, undefined, {
          processRunner: runner,
          resolveNetworkTrust: async () => trust,
        }).sources
      : (
          await Effect.runPromise(
            retainedSourceTransports().pipe(
              Effect.provideService(ProcessRunner, runner),
              Effect.provideService(NetworkTrust, trust),
            ),
          )
        ).transports;
  const resolve = transports.git?.resolve;
  if (resolve === undefined) throw new Error("composition must supply git ref resolution");
  expect(await resolve({ url: "https://example.test/repo.git" })).toBe(commit);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.args).toContain("http.proxy=http://resolved-proxy.test:3128");
});

test("cold build source metadata and tarballs use invocation network trust", async () => {
  const packageName = "lando-build-trust-fixture";
  const archive = await new Bun.Archive({
    "package/package.json": '{"name":"lando-build-trust-fixture"}',
  }).bytes();
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
  const tarball = "https://build-artifacts.test/fixture.tgz";
  const requested: Array<{ readonly url: URL; readonly proxy: unknown; readonly tls: unknown }> = [];
  const proxy = "http://proxy-for-this-build.test:3128";
  const fetchImpl = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requested.push({
        url,
        proxy: init && "proxy" in init ? init.proxy : undefined,
        tls: init && "tls" in init ? init.tls : undefined,
      });
      return Promise.resolve(
        url.href === tarball
          ? new Response(archive)
          : Response.json({
              versions: {
                "1.0.0": { dist: { tarball, integrity } },
              },
            }),
      );
    },
    { preconnect: () => {} },
  );
  const http = layerWith({ fetch: fetchImpl, systemCaPems: () => [] });
  const downloads = downloaderLayer.pipe(Layer.provideMerge(http));
  await withTestSources({}, ({ stateStore }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session } = yield* BuildSourceStore;
        const leased = yield* session;
        yield* leased.acquireExactNpm({ name: packageName, version: "1.0.0" });
      }).pipe(
        Effect.provideService(NetworkTrust, {
          proxy: { https: proxy, noProxy: [] },
          caPems: ["build-root"],
          trustHost: false,
        }),
        Effect.provide(
          buildSourceStoreLayer.pipe(
            Layer.provide(Layer.merge(downloads, Layer.succeed(StateStore, stateStore))),
          ),
        ),
      ),
    ),
  );
  expect(requested.map(({ url }) => url.pathname)).toEqual([`/${packageName}`, "/fixture.tgz"]);
  for (const request of requested) {
    expect(request.proxy).toMatchObject({ url: proxy });
    expect(request.tls).toMatchObject({ ca: ["build-root"] });
  }
});
