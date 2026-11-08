import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import { scopedLandofileRuntimeInputs } from "@lando/engine/services/landofile-live";
import { Downloader, OnlineAcquisition } from "@lando/sdk/services";
import { retainedSourceTransports } from "../../src/recipes/runtime-sources.ts";
import { baseEngineCompositionInputs } from "../../src/runtime/engine-composition.ts";

test.each([true, false])(
  "archive transports carry the caller's acquisition context (%s)",
  async (enabled) => {
    const observed: boolean[] = [];
    const payload = new TextEncoder().encode("archive bytes");
    const downloader = Downloader.of({
      id: "archive-context",
      capabilities: {
        schemes: ["https"],
        memoryDownload: false,
        cacheAware: false,
        offline: false,
        mirror: false,
      },
      download: Effect.fnUntraced(function* (request) {
        observed.push(yield* OnlineAcquisition);
        if (request.destination.kind !== "file") return yield* Effect.die("Expected file destination");
        const path = join(request.destination.directory, request.destination.filename);
        yield* Effect.promise(() => writeFile(path, payload));
        return {
          url: request.url,
          kind: "file" as const,
          path,
          sha256: "unused-by-transport",
          sizeBytes: payload.length,
          fromCache: false,
        };
      }),
    });
    expect(baseEngineCompositionInputs.landofileSourcePorts).toBeDefined();
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const recipes = yield* retainedSourceTransports();
        const includes = yield* scopedLandofileRuntimeInputs;
        const recipeArchive = recipes.transports.archive;
        if (recipeArchive === undefined) return yield* Effect.die("Missing recipe archive transport");
        const recipeBytes = yield* Effect.promise(() =>
          recipeArchive.fetch("https://archive.test/recipe.tgz"),
        );
        const archive = includes.ports.sources?.archive;
        if (archive === undefined) return yield* Effect.die("Missing include archive transport");
        const includeBytes = yield* Effect.promise(() => archive.fetch("https://archive.test/include.tgz"));
        return [recipeBytes, includeBytes];
      }).pipe(
        Effect.provideService(OnlineAcquisition, enabled),
        Effect.provideService(Downloader, downloader),
      ),
    );
    expect(results).toEqual([payload, payload]);
    expect(observed).toEqual([enabled, enabled]);
  },
);
