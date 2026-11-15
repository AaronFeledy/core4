import { expect, test } from "bun:test";
import { DataTargetExistsError } from "@lando/sdk/errors";
import type { VolumeArchiveImportSpec } from "@lando/sdk/services";
import { Effect, Stream } from "effect";
import { runScoped, store, withCatalog } from "./catalog-fixture.ts";
import { concatBytes, tarArchive } from "./tar-fixture.ts";

const recorder = () => {
  let committed: Uint8Array | undefined;
  return {
    get committed() {
      return committed;
    },
    importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) =>
      Effect.gen(function* () {
        const archive = yield* Stream.runCollect(spec.archive).pipe(
          Effect.map((chunks) => concatBytes(chunks)),
        );
        yield* spec.beforeCommit;
        committed = archive;
      }),
  };
};

test("a fresh import succeeds even though extraction creates the target volume", async () => {
  await withCatalog(async (f) => {
    const archive = tarArchive([{ name: "payload", data: "new-data" }]);
    let listings = 0;
    const sink = recorder();
    const provider = f.provider({
      listVolumes: () => {
        listings += 1;
        // Only the admission check before extraction may list volumes; the extractor's
        // own volume shows up afterwards and must not count as a conflict.
        return Effect.succeed(
          listings === 1 ? [] : [{ ref: store, instanceId: "00000000-0000-4000-8000-000000000001" }],
        );
      },
      exportVolume: () => Stream.make(archive),
      importVolume: sink.importVolume,
    });

    const result = await runScoped(
      f
        .mover(provider)
        .transfer({
          from: { _tag: "volume", app: store.app, store: "source" },
          to: { _tag: "volume", app: store.app, store: store.store },
        })
        .pipe(Effect.result),
    );

    expect(result._tag).toBe("Success");
    expect(sink.committed).toEqual(archive);
    expect(listings).toBe(1);
  });
});

test("a target that existed before import is refused without overwrite", async () => {
  await withCatalog(async (f) => {
    const archive = tarArchive([{ name: "payload", data: "new-data" }]);
    const sink = recorder();
    const provider = f.provider({
      listVolumes: () => Effect.succeed([{ ref: store }]),
      exportVolume: () => Stream.make(archive),
      importVolume: sink.importVolume,
    });

    const result = await runScoped(
      f
        .mover(provider)
        .transfer({
          from: { _tag: "volume", app: store.app, store: "source" },
          to: { _tag: "volume", app: store.app, store: store.store },
        })
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataTargetExistsError" } });
    expect(result._tag === "Failure" ? result.failure : undefined).toBeInstanceOf(DataTargetExistsError);
    expect(sink.committed).toBeUndefined();
  });
});

test("a provider without typed volume archives is refused before reading the source", async () => {
  await withCatalog(async (f) => {
    const provider = f.provider({ capabilities: { ...f.recording.capabilities, volumeArchive: false } });

    const result = await runScoped(
      f
        .mover(provider)
        .transfer({
          from: { _tag: "volume", app: store.app, store: "source" },
          to: { _tag: "volume", app: store.app, store: store.store },
        })
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataEndpointUnsupportedError" } });
  });
});
