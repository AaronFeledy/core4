import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { Deferred, Effect, Fiber } from "effect";
import { run, runScoped, store, withCatalog } from "./catalog-fixture.ts";

const storeFailure = () =>
  new StateStoreError({ reason: "io", operation: "fixture", remediation: "Injected fixture failure." });

test.each(["missing", "several", "native-name", "no-match"])(
  "snapshot fails before acquisition for %s source identity",
  (scenario) =>
    withCatalog(async (f) => {
      // Given invalid physical ownership evidence from an exact-filter query.
      const source = (await run(f.recording.listVolumes(store)))[0];
      if (source?.identity === undefined) throw new Error("Expected fixture identity");
      const volumes =
        scenario === "missing"
          ? [{ ref: source.ref }]
          : scenario === "several"
            ? [source, source]
            : scenario === "no-match"
              ? []
              : [{ ...source, identity: { ...source.identity, nativeName: "foreign" } }];
      const mover = f.mover(f.provider({ listVolumes: () => Effect.succeed(volumes) }));
      // When creating a snapshot without any caller-supplied database metadata.
      const result = await runScoped(mover.snapshot(store).pipe(Effect.result));
      // Then ownership fails without native data or catalog mutations.
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
      expect(f.artifacts.size).toBe(0);
      expect(await f.files()).toEqual([]);
    }),
);

test.each(["copy", "native"] as const)(
  "failed %s acquisition rolls back the artifact before sidecar commit",
  (mode) =>
    withCatalog(async (f) => {
      // Given a disk store whose bucket preparation fails after artifact acquisition.
      const storage = StateStore.of({ ...f.stateStore, open: () => Effect.fail(storeFailure()) });
      // When creating a snapshot.
      const result = await runScoped(
        f.mover(f.recording, storage).snapshot(store, { volumeSnapshot: mode }).pipe(Effect.result),
      );
      // Then neither a completed archive nor a native ref nor a sidecar survives.
      expect(result._tag).toBe("Failure");
      expect((await f.files()).filter((name) => /\.(json|tar)$/u.test(name))).toEqual([]);
      expect(f.artifacts.size).toBe(0);
      expect(f.removals.length).toBe(mode === "native" ? 1 : 0);
    }),
);

test.each(["copy", "native"] as const)("interrupted %s creation rolls back a returned artifact", (mode) =>
  withCatalog(async (f) => {
    // Given a paused sidecar open after the archive/native ref has been acquired.
    const ready = await run(Deferred.make<void>());
    const storage = StateStore.of({
      ...f.stateStore,
      open: () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
    });
    // When the snapshot fiber is interrupted before committing.
    await runScoped(
      Effect.gen(function* () {
        const fiber = yield* f
          .mover(f.recording, storage)
          .snapshot(store, { volumeSnapshot: mode })
          .pipe(Effect.forkChild);
        yield* Deferred.await(ready);
        yield* Fiber.interrupt(fiber);
      }),
    );
    // Then the scope finalizer removes all uncommitted data.
    expect((await f.files()).filter((name) => /\.(json|tar)$/u.test(name))).toEqual([]);
    expect(f.artifacts.size).toBe(0);
    expect(f.removals.length).toBe(mode === "native" ? 1 : 0);
  }),
);

test.each(["copy", "native"] as const)("%s sidecar write that fails before writing rolls back", (mode) =>
  withCatalog(async (f) => {
    // Given a sidecar write that fails without committing anything.
    const storage = StateStore.of({
      ...f.stateStore,
      open: (spec) =>
        f.stateStore
          .open(spec)
          .pipe(Effect.map((bucket) => ({ ...bucket, set: () => Effect.fail(storeFailure()) }))),
    });
    // When snapshot creation fails.
    const result = await runScoped(
      f.mover(f.recording, storage).snapshot(store, { volumeSnapshot: mode }).pipe(Effect.result),
    );
    // Then nothing is left behind: no sidecar, no archive, no provider image.
    expect(result._tag).toBe("Failure");
    expect((await f.files()).filter((name) => /\.(json|tar)$/u.test(name))).toEqual([]);
    expect(f.artifacts.size).toBe(0);
    expect(f.removals.length).toBe(mode === "native" ? 1 : 0);
  }),
);

test.each(["copy", "native"] as const)("ambiguous %s sidecar write preserves its data", (mode) =>
  withCatalog(async (f) => {
    // Given a real sidecar write that reports failure after committing its bytes.
    const storage = StateStore.of({
      ...f.stateStore,
      open: (spec) =>
        f.stateStore.open(spec).pipe(
          Effect.map((bucket) => ({
            ...bucket,
            set: (value) => bucket.set(value).pipe(Effect.andThen(Effect.fail(storeFailure()))),
          })),
        ),
    });
    // When snapshot creation receives that ambiguous failure.
    const result = await runScoped(
      f.mover(f.recording, storage).snapshot(store, { volumeSnapshot: mode }).pipe(Effect.result),
    );
    // Then it fails visibly but keeps the artifact referenced by the committed sidecar.
    expect(result._tag).toBe("Failure");
    const listed = await run(f.mover().listSnapshots({}));
    expect(listed).toHaveLength(1);
    expect(f.removals).toEqual([]);
    expect(f.artifacts.size).toBe(mode === "native" ? 1 : 0);
    expect((await f.files()).filter((name) => name.endsWith(".tar")).length).toBe(mode === "copy" ? 1 : 0);
  }),
);

test("removal routes to recording provider A when call-time provider is B", () =>
  withCatalog(async (f) => {
    // Given a snapshot on A and an unrelated call-time provider B.
    const handle = await runScoped(f.mover().snapshot(store));
    const wrongCalls: string[] = [];
    const target = f.provider({
      id: "B",
      removeVolumeSnapshot: (ref) =>
        Effect.sync(() => {
          wrongCalls.push(ref.id);
        }),
    });
    // When removing the owner-bound handle with B selected.
    await run(f.mover(target).removeSnapshot(handle));
    // Then only A removes its artifact.
    expect(f.removals).toEqual([handle.id]);
    expect(wrongCalls).toEqual([]);
  }));

test("missing recording provider leaves the snapshot listed", () =>
  withCatalog(async (f) => {
    // Given a snapshot recorded by A, which the registry can no longer select.
    const handle = await runScoped(f.mover().snapshot(store));
    const registry = RuntimeProviderRegistry.of({
      ...f.registry,
      select: () =>
        Effect.fail(
          new ProviderUnavailableError({
            providerId: "A",
            message: "offline",
            operation: "select",
            remediation: "Install or start the `A` provider and confirm it can perform `select`.",
          }),
        ),
    });
    const mover = f.mover(f.provider({ id: "B" }), f.stateStore, registry);
    // When removal fails to resolve its recording provider.
    const result = await run(mover.removeSnapshot(handle).pipe(Effect.result));
    // Then the error names A and ownership evidence is retained for retry.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DataTransferError", message: expect.stringContaining("A") },
    });
    expect((await run(mover.listSnapshots({}))).map((info) => info.id)).toEqual([handle.id]);
    expect(f.removals).toEqual([]);
  }));

test("cross-provider native restore fails before touching the target", () =>
  withCatalog(async (f) => {
    // Given an A snapshot and a B target.
    const handle = await runScoped(f.mover().snapshot(store));
    let actions = 0;
    const provider = f.provider({
      id: "B",
      restoreVolume: () =>
        Effect.sync(() => {
          actions += 1;
        }),
    });
    // When restoring across providers.
    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));
    // Then physical movement is rejected with a logical-transfer alternative.
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "DataTransferError", remediation: expect.stringContaining("db:export") },
    });
    expect(actions).toBe(0);
  }));

test.each(["native", "copy"] as const)("%s restore rejects a different target owner", (mode) =>
  withCatalog(async (f) => {
    // Given a snapshot and a target volume with another canonical owner.
    const handle = await runScoped(f.mover().snapshot(store, { volumeSnapshot: mode }));
    const targets = await run(f.recording.listVolumes(store));
    let actions = 0;
    const provider = f.provider({
      listVolumes: () =>
        Effect.succeed(
          targets.map((target) =>
            target.identity === undefined
              ? target
              : {
                  ...target,
                  identity: { ...target.identity, ownerRoot: AbsolutePath.make("/foreign") },
                },
          ),
        ),
      restoreVolume: () =>
        Effect.sync(() => {
          actions += 1;
        }),
      run: () =>
        Effect.sync(() => {
          actions += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    });
    // When restoring without optional database metadata.
    const result = await runScoped(f.mover(provider).restore(handle, store).pipe(Effect.result));
    // Then the owner mismatch is sufficient to reject before mutation.
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "SnapshotOwnershipError" } });
    expect(actions).toBe(0);
  }),
);

test("legacy app-id native refs remain protected from discovery and removal", () =>
  withCatalog(async (f) => {
    // Given an old native image referenced only by a development-build catalog.
    const ref = f.info("legacy").native;
    if (ref === undefined) throw new Error("Expected native fixture");
    f.artifacts.set(ref.id, ref);
    const dir = join(f.paths.snapshotsDir, "old-app-id");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "index.bin"),
      JSON.stringify({
        version: 1,
        data: [{ native: { provider: ref.provider, id: ref.id }, obsolete: true }],
      }),
    );
    const images = await run(f.recording.listVolumeSnapshots?.() ?? Effect.succeed([]));
    const image = images[0];
    if (image === undefined) throw new Error("Expected image fixture");
    // When GC discovers and independently rechecks removal.
    const found = await run(f.mover().findOrphanedSnapshots);
    const removal = await run(f.mover().removeOrphanedSnapshot(image).pipe(Effect.result));
    // Then the legacy ref is never eligible.
    expect(found).toEqual([]);
    expect(removal._tag).toBe("Failure");
    expect(f.removals).toEqual([]);
  }));

test.each(["unreadable", "invalid-json", "unsupported-version"])(
  "legacy catalog %s fails GC closed",
  (kind) =>
    withCatalog(async (f) => {
      // Given an orphan candidate and a legacy catalog that cannot be interpreted safely.
      const ref = f.info("orphan").native;
      if (ref === undefined) throw new Error("Expected native fixture");
      f.artifacts.set(ref.id, ref);
      const dir = join(f.paths.snapshotsDir, "old-app-id");
      await mkdir(dir, { recursive: true });
      const file = join(dir, "index.bin");
      if (kind === "unreadable") await mkdir(file);
      else
        await writeFile(file, kind === "invalid-json" ? "broken" : JSON.stringify({ version: 2, data: [] }));
      const image = (await run(f.recording.listVolumeSnapshots?.() ?? Effect.succeed([])))[0];
      if (image === undefined) throw new Error("Expected image fixture");
      // When discovery and orphan removal inspect legacy evidence.
      const results = await run(
        Effect.all([
          f.mover().findOrphanedSnapshots.pipe(Effect.result),
          f.mover().removeOrphanedSnapshot(image).pipe(Effect.result),
        ]),
      );
      // Then both fail with the offending path and neither removes the image.
      for (const result of results)
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "DataTransferError", message: expect.stringContaining(file) },
        });
      expect(f.removals).toEqual([]);
    }),
);
