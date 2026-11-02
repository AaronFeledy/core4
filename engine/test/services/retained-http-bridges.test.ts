import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as DownloaderLayer from "@lando/http-client/downloader";
import * as Sources from "@lando/paths/config-sources";
import { ConfigService, Downloader } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { layerWith } from "../../src/services/config";
import { httpJsonFetch } from "../../src/services/json-fetch";
import { defaultFetchManifestBytes } from "../../src/update/manifest";

test("async metadata bridges use retained services without acquiring config again", async () => {
  // Given a retained config and HTTP transport, followed by an invalid source edit.
  const root = await mkdtemp(join(tmpdir(), "lando-retained-fetch-"));
  const file = join(root, "config.yml");
  await writeFile(file, "router:\n  httpPort: 8123\n");
  const acquisition = spyOn(Sources, "readGlobalConfigSources");
  const requests: string[] = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      return HttpClientResponse.fromWeb(request, new Response("retained"));
    }),
  );
  const http = Layer.succeed(HttpClient.HttpClient, client);
  const runtime = Layer.mergeAll(
    layerWith({ env: {}, sources: { user: true, env: false }, rootOverrides: { userConfRoot: root } }),
    http,
    DownloaderLayer.layer.pipe(Layer.provide(http)),
  );
  try {
    // When both Promise bridges execute after the source becomes invalid.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ConfigService;
        const downloader = yield* Downloader;
        yield* Effect.promise(() => writeFile(file, "router: [opaque-canary-late\n"));
        const json = yield* Effect.tryPromise({
          try: () => httpJsonFetch("https://retained.test/metadata", {}, client),
          catch: (cause) => cause,
        });
        const manifest = yield* Effect.tryPromise({
          try: () => defaultFetchManifestBytes("https://retained.test/manifest", downloader),
          catch: (cause) => cause,
        });
        return { json, manifest, port: (yield* config.get("router"))?.httpPort };
      }).pipe(Effect.provide(runtime)),
    );
    // Then both use the retained transport and no second snapshot observes the invalid file.
    expect(new TextDecoder().decode(result.json.bytes)).toBe("retained");
    expect(new TextDecoder().decode(result.manifest)).toBe("retained");
    expect(requests).toEqual(["https://retained.test/metadata", "https://retained.test/manifest"]);
    expect(result.port).toBe(8123);
    expect(acquisition).toHaveBeenCalledTimes(1);
  } finally {
    acquisition.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
