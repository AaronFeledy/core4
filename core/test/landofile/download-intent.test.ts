import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as LandofileRuntime from "@lando/engine/services/landofile-live";
import { withResolvedCwd } from "@lando/landofile/app-resolution";
import { makeLandoPaths } from "@lando/paths";
import { DownloadFetchError } from "@lando/sdk/errors";
import {
  Downloader,
  LandofileService,
  ManagedFileTransactionGuard,
  OnlineAcquisition,
  PathsService,
  StateStore,
} from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Layer } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import "../../src/runtime/engine-composition.ts";

test("a retained LandofileService uses acquisition intent from each discover caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-discover-intent-"));
  const observed: boolean[] = [];
  const paths = makeLandoPaths({ userCacheRoot: join(root, "cache"), userDataRoot: join(root, "data") });
  const downloader = Downloader.of({
    id: "discover-context",
    capabilities: {
      schemes: ["https"],
      memoryDownload: false,
      cacheAware: false,
      offline: false,
      mirror: false,
    },
    download: Effect.fnUntraced(function* () {
      observed.push(yield* OnlineAcquisition);
      return yield* Effect.fail(
        new DownloadFetchError({
          message: "Missing fixture archive",
          urlOrigin: "https://registry.test",
          reason: "http-status",
          status: 404,
          remediation: "Inspect fixture URL.",
        }),
      );
    }),
  });
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          name: "fragments",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: "fragments",
              version: "1.0.0",
              dist: {
                tarball: "https://registry.test/fragments.tgz",
                integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
              },
            },
          },
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(
    Layer.succeed(Downloader, downloader),
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(PathsService, paths),
    Layer.succeed(
      StateStore,
      makeStateStore({
        roots: paths.roots,
        privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
      }),
    ),
    Layer.succeed(ManagedFileTransactionGuard, {
      assertReadable: () => Effect.void,
      ensureConsistent: () => Effect.void,
      pending: () => Effect.succeed(null),
    }),
  );
  try {
    await writeFile(
      join(root, ".lando.yml"),
      "name: discover-intent\nincludes:\n  - source: npm:fragments\n    path: fragment.yml\n",
    );
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* LandofileService;
        const acquisition = yield* Effect.result(
          withResolvedCwd(root, service.discover).pipe(Effect.provideService(OnlineAcquisition, true)),
        );
        const routine = yield* Effect.result(
          withResolvedCwd(root, service.discover).pipe(Effect.provideService(OnlineAcquisition, false)),
        );
        return [acquisition._tag, routine._tag];
      }).pipe(
        Effect.provide(LandofileRuntime.layerDefault.pipe(Layer.provide(dependencies))),
        Effect.provideService(OnlineAcquisition, false),
      ),
    );
    expect(results).toEqual(["Failure", "Failure"]);
    expect(observed).toEqual([true, false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
