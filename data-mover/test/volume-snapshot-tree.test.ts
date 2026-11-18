import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotOwnershipError } from "@lando/sdk/errors";
import { type ArchiveFormat, ServiceName, type snapshotHandle } from "@lando/sdk/schema";
import type { VolumeArchiveImportSpec } from "@lando/sdk/services";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { Effect, Stream } from "effect";
import { run, runScoped, store, withCatalog } from "./catalog-fixture.ts";
import { concatBytes, decompressArchive, parseTarArchive, tarArchive } from "./tar-fixture.ts";

const treeTar = (): Uint8Array =>
  tarArchive([
    { name: "./", typeflag: "5" },
    { name: "./database/", typeflag: "5" },
    { name: "./database/app.sql", data: "database-payload", uid: 999 },
    { name: "./database/nested/", typeflag: "5", mode: 0o700 },
    { name: "./database/nested/value.txt", data: "nested-payload" },
    { name: "./database/link", typeflag: "2", linkname: "app.sql" },
  ]);

/** Records what the provider actually committed, mirroring staged provider semantics. */
const importRecorder = () => {
  const committed: Uint8Array[] = [];
  let imports = 0;
  return {
    get imports() {
      return imports;
    },
    get committed() {
      return committed;
    },
    importVolume: <E, R>(spec: VolumeArchiveImportSpec<E, R>) =>
      Effect.gen(function* () {
        imports += 1;
        const archive = yield* Stream.runCollect(spec.archive).pipe(
          Effect.map((chunks) => concatBytes(chunks)),
        );
        yield* spec.beforeCommit;
        committed.push(archive);
      }),
  };
};

const copyMetadata = (volumeInstanceId: string) => ({
  service: ServiceName.make("database"),
  volumeInstanceId,
  family: "mysql",
  version: "8.0",
  imageIdentity: "sha256:mysql-runtime",
  recoveryReason: "manual" as const,
});

const snapshotArchivePath = (
  fixture: { readonly paths: { readonly snapshotsDir: string } },
  handle: ReturnType<typeof snapshotHandle>,
  format: ArchiveFormat,
) => join(fixture.paths.snapshotsDir, handle.ownerKey, handle.store.store, `${handle.id}.${format}`);

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Rewrite the persisted sidecar so a restore has to judge the tampered record. */
const tamperSidecar = async (
  fixture: { readonly paths: { readonly snapshotsDir: string } },
  handle: ReturnType<typeof snapshotHandle>,
  mutate: (info: Record<string, unknown>) => void,
) => {
  const path = join(fixture.paths.snapshotsDir, handle.ownerKey, handle.store.store, `${handle.id}.json`);
  const envelope = JSON.parse(await readFile(path, "utf8")) as {
    version: number;
    data: Record<string, unknown>;
  };
  mutate(envelope.data);
  await writeFile(path, `${JSON.stringify(envelope, null, 2)}\n`);
};

test.each(["tar", "tar.gz", "tar.zst"] as const)(
  "copy-mode snapshot stores the volume archive directly (%s)",
  async (format) => {
    await withCatalog(async (f) => {
      const tree = treeTar();
      const provider = f.provider({ exportVolume: () => Stream.make(tree) });

      const handle = await runScoped(f.mover(provider).snapshot(store, { volumeSnapshot: "copy", format }));
      const archivePath = snapshotArchivePath(f, handle, format);
      const stored = new Uint8Array(await readFile(archivePath));
      const entries = parseTarArchive(decompressArchive(stored, format));
      const names = entries.map((entry) => entry.name);
      expect(names).toContain("./database/app.sql");
      expect(names).toContain("./database/nested/value.txt");
      expect(names).toContain("./database/link");
      expect(names).not.toContain("payload");
      expect(new TextDecoder().decode(entries[2]?.data)).toBe("database-payload");

      const info = await run(f.mover().resolveSnapshot(handle.id, { ownerKey: handle.ownerKey }));
      expect(info.digest).toBe(sha256(stored));
      expect(info.sizeBytes).toBe(stored.byteLength);
      expect(info.format).toBe(format);
      expect(info.sourceVolumeGeneration).toBeDefined();
    });
  },
);

test.each(["tar", "tar.gz"] as const)(
  "copy-mode restore streams the archive straight into the provider for %s",
  async (format) => {
    await withCatalog(async (f) => {
      const tree = treeTar();
      const snapshotProvider = f.provider({ exportVolume: () => Stream.make(tree) });
      const handle = await runScoped(
        f.mover(snapshotProvider).snapshot(store, { volumeSnapshot: "copy", format }),
      );
      const recorder = importRecorder();
      const restoreProvider = f.provider({ importVolume: recorder.importVolume });

      await runScoped(f.mover(restoreProvider).restore(handle, store));

      expect(recorder.imports).toBe(1);
      expect(Array.from(recorder.committed[0] ?? [])).toEqual(Array.from(tree));
      expect(await readdir(f.paths.transferStagingDir).catch(() => [])).toEqual([]);
    });
  },
);

test("restore refuses a target volume replaced while the archive was read", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const metadata = copyMetadata(source.identity.generation);
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
        metadata,
      }),
    );

    const changed = {
      ...source,
      instanceId: "00000000-0000-4000-8000-000000000002",
      identity: {
        ...source.identity,
        generation: "00000000-0000-4000-8000-000000000002",
      },
    };
    let listings = 0;
    const recorder = importRecorder();
    const provider = f.provider({
      listVolumes: () => {
        listings += 1;
        return Effect.succeed([listings === 1 ? source : changed]);
      },
      importVolume: recorder.importVolume,
    });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
    expect(result._tag === "Failure" ? result.failure : undefined).toBeInstanceOf(SnapshotOwnershipError);
    expect(recorder.committed).toEqual([]);
  });
});

test("restore rejects an absent target volume before reading the archive", async () => {
  await withCatalog(async (f) => {
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    const recorder = importRecorder();
    const provider = f.provider({
      listVolumes: () => Effect.succeed([]),
      importVolume: recorder.importVolume,
    });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotOwnershipError",
        message: "Physical restore target identity is unknown.",
      },
    });
    expect(recorder.imports).toBe(0);
  });
});

test("restore rejects a target whose identity disappears before publication", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    const { identity: _identity, ...withoutIdentity } = source;
    let listings = 0;
    const recorder = importRecorder();
    const provider = f.provider({
      listVolumes: () =>
        Effect.sync(() => {
          listings += 1;
          return listings === 1 ? [source] : [{ ...withoutIdentity, provenance: "legacy" as const }];
        }),
      importVolume: recorder.importVolume,
    });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotOwnershipError",
        message: "Physical restore target identity is unknown.",
      },
    });
    expect(listings).toBe(2);
    expect(recorder.committed).toEqual([]);
  });
});

test("copy restore rejects a provider without typed volume archives before reading the archive", async () => {
  await withCatalog(async (f) => {
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    const recorder = importRecorder();
    const provider = f.provider({
      capabilities: { ...f.recording.capabilities, volumeArchive: false, ephemeralMounts: false },
      importVolume: recorder.importVolume,
    });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "DataEndpointUnsupportedError" } });
    expect(recorder.imports).toBe(0);
  });
});

test("seed mode restore imports the snapshot archive into an in-progress volume", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const metadata = copyMetadata(source.identity.generation);
    const tree = treeTar();
    const snapshotProvider = f.provider({ exportVolume: () => Stream.make(tree) });
    const handle = await runScoped(
      f.mover(snapshotProvider).snapshot(store, { volumeSnapshot: "copy", format: "tar", metadata }),
    );
    const initialization = await run(volumeInitialization(f.stateStore, source.identity));
    await run(initialization.recordCreation);
    expect(await run(initialization.begin("seed-test"))).toBe(true);
    const recorder = importRecorder();
    const provider = f.provider({ importVolume: recorder.importVolume });

    await runScoped(f.mover(provider).restore(handle, store, { mode: "seed" }));

    const entries = parseTarArchive(recorder.committed[0] ?? new Uint8Array());
    expect(entries.map((entry) => entry.name)).toContain("./database/app.sql");
  });
});

test("restore refuses a snapshot archive that no longer matches its recorded digest", async () => {
  await withCatalog(async (f) => {
    const tree = treeTar();
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(tree) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    const archivePath = snapshotArchivePath(f, handle, "tar");
    const damaged = new Uint8Array(await readFile(archivePath));
    damaged[damaged.byteLength - 1] = 0x21;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(archivePath, damaged);
    const recorder = importRecorder();

    const result = await runScoped(
      f
        .mover(f.provider({ importVolume: recorder.importVolume }))
        .restore(handle, store)
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DataChecksumMismatchError" },
    });
    expect(recorder.committed).toEqual([]);
  });
});

test("restore refuses a physical snapshot whose recorded generation is missing (#2389)", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    await tamperSidecar(f, handle, (stored) => {
      stored.sourceVolumeGeneration = undefined;
      stored.metadata = undefined;
    });
    const recorder = importRecorder();
    const provider = f.provider({ importVolume: recorder.importVolume });

    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));

    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
    expect(recorder.committed).toEqual([]);
  });
});

test("restore refuses when snapshot generations disagree (#2389)", async () => {
  await withCatalog(async (f) => {
    const source = (await run(f.recording.listVolumes(store)))[0];
    if (source?.identity === undefined) throw new Error("Expected fixture identity");
    const handle = await runScoped(
      f.mover(f.provider({ exportVolume: () => Stream.make(treeTar()) })).snapshot(store, {
        volumeSnapshot: "copy",
        format: "tar",
      }),
    );
    await tamperSidecar(f, handle, (stored) => {
      stored.sourceVolumeGeneration = "00000000-0000-4000-8000-000000000009";
      stored.metadata = { ...copyMetadata("00000000-0000-4000-8000-000000000001") };
    });
    const recorder = importRecorder();

    const result = await runScoped(
      f
        .mover(f.provider({ importVolume: recorder.importVolume }))
        .restore(handle, store)
        .pipe(Effect.result),
    );

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "SnapshotOwnershipError",
        message: "The snapshot records conflicting physical source volume generations.",
      },
    });
    expect(recorder.committed).toEqual([]);
  });
});
