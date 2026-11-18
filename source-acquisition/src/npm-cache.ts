import { lstat } from "node:fs/promises";
import { mapFailures } from "@lando/sdk/command-result";
import { isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import { acquisitionError, displaySource } from "./errors.ts";
import { metadata } from "./gc-inventory.ts";
import { verifyAuthoredNpmDigest, verifyNpmFile } from "./npm-authored-integrity.ts";
import { type NpmIndexRecord, sourceRecords } from "./records.ts";
import { type Storage, io } from "./storage.ts";
import { containedPath } from "./tree.ts";
import type { ExactNpmSource, NpmPin } from "./types.ts";

type Coordinate = Pick<NpmPin, "name" | "version">;

export const npmCache = (stateStore: Parameters<typeof sourceRecords>[0], storage: Storage) => {
  const { npm: index } = sourceRecords(stateStore);
  const openIndexed = (coordinate: Coordinate, registry: string, record: typeof NpmIndexRecord.Type) =>
    storage.open({ kind: "archive", sha256: record.sha256 }, {
      kind: "npm",
      name: coordinate.name,
      version: coordinate.version,
      registry,
      dist: {
        tarball: "",
        ...(record.integrity === undefined ? {} : { integrity: record.integrity }),
        ...(record.shasum === undefined ? {} : { shasum: record.shasum }),
      },
    } satisfies NpmPin);

  // Include pins carry fragment checksums, so their fallback can use any registry.
  const lookupAnyRegistry = Effect.fn("SourceSession.lookupNpmAnyRegistry")(function* (
    coordinate: Coordinate,
  ) {
    const candidates: { readonly record: typeof NpmIndexRecord.Type; readonly usedAt: number }[] = [];
    for (const row of yield* metadata(storage.root, stateStore)) {
      if (row.kind !== "npm-index" || row.value.name !== coordinate.name) continue;
      if (row.value.version !== coordinate.version) continue;
      const usedAt = yield* io(row.name, async () => {
        try {
          return (await lstat(containedPath(storage.root, "archive", row.value.sha256, "entry.json")))
            .mtimeMs;
        } catch (cause) {
          if (isErrnoCode(cause, "ENOENT")) return undefined;
          throw cause;
        }
      });
      if (usedAt !== undefined) candidates.push({ record: row.value, usedAt });
    }
    candidates.sort((left, right) => right.usedAt - left.usedAt);
    for (const { record } of candidates) {
      const snapshot = yield* openIndexed(coordinate, record.registry, record);
      if (snapshot !== undefined) return snapshot;
    }
    return undefined;
  });

  const indexedRecord = Effect.fnUntraced(function* (coordinate: Coordinate, registry: string) {
    const bucket = yield* index(registry, coordinate.name, coordinate.version);
    const record = yield* bucket.get.pipe(
      mapFailures((error) => acquisitionError("cache", coordinate.name, error)),
    );
    return record?.name === coordinate.name &&
      record.version === coordinate.version &&
      record.registry === displaySource(registry)
      ? record
      : undefined;
  });

  const lookupExact = Effect.fnUntraced(function* (coordinate: ExactNpmSource, registry: string) {
    const record = yield* indexedRecord(coordinate, registry);
    if (record === undefined) return undefined;
    const snapshot = yield* openIndexed(coordinate, registry, record);
    const { name, version, integrity } = coordinate;
    if (snapshot === undefined || integrity === undefined) return snapshot;
    const source = `${name}@${version}`;
    if (integrity.file !== undefined) {
      yield* verifyNpmFile(source, { ...integrity, file: integrity.file })(snapshot.root);
      return snapshot;
    }
    const actual =
      integrity.algorithm === "sha256" ? record.sha256 : record.tarballDigests?.[integrity.algorithm];
    if (actual === undefined) return undefined;
    yield* verifyAuthoredNpmDigest(source, integrity, actual);
    return snapshot;
  });

  const openMaterialized = (pin: NpmPin, record: typeof NpmIndexRecord.Type | null, verify: boolean) =>
    record !== null &&
    record.registry === displaySource(pin.registry) &&
    record.name === pin.name &&
    record.version === pin.version &&
    record.integrity === pin.dist.integrity &&
    record.shasum === pin.dist.shasum
      ? storage.open({ kind: "archive", sha256: record.sha256 }, pin, { verify })
      : Effect.succeed(undefined);

  return { index, lookupAnyRegistry, lookupExact, openMaterialized };
};
