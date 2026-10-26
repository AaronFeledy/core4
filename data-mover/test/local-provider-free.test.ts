import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { AbsolutePath } from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect, Layer, Stream } from "effect";
import { layer } from "../src/service.ts";

test("copies local bytes with no RuntimeProvider binding or provider selection", async () => {
  const dir = await mkdtemp(resolve(process.cwd(), ".tmp-data-local-"));
  const source = resolve(dir, "in.txt");
  const target = resolve(dir, "out.txt");
  const registry = RuntimeProviderRegistry.of({
    list: Effect.die("Local copy must not enumerate providers"),
    capabilities: Effect.die("Local copy must not inspect provider capabilities"),
    appliedPlansFor: () => Effect.die("Local copy must not inspect applied plans"),
    resolveAppliedPlan: () => Effect.die("Local copy must not resolve a provider"),
    resolveTeardownEvidence: () => Effect.die("Local copy must not resolve teardown"),
    select: () => Effect.die("Local copy must not select a provider"),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: dir })),
    Layer.succeed(RuntimeProviderRegistry, registry),
    RedactionService.layer,
    Layer.succeed(
      EventService,
      EventService.of({
        publish: () => Effect.void,
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.never,
        waitFor: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  try {
    await writeFile(source, "local-bytes");
    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(DataMover, (mover) =>
          mover.transfer({
            from: { _tag: "hostPath", path: AbsolutePath.make(source) },
            to: { _tag: "hostPath", path: AbsolutePath.make(target) },
            overwrite: true,
          }),
        ),
      ).pipe(Effect.provide(layer.pipe(Layer.provide(dependencies)))),
    );
    expect(await readFile(target, "utf8")).toBe("local-bytes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
