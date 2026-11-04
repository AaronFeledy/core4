import { lstat } from "node:fs/promises";
import { sha256Hex } from "@lando/sdk/digest";
import { isErrnoCode } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { archiveAcquisition } from "./acquire-archive.ts";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { metadata } from "./gc-inventory.ts";
import { checkNpmPackageDistIntegrity } from "./integrity.ts";
import { parseNpmPackageSpec, resolveNpmPackageVersion } from "./npm.ts";
import { type NpmIndexRecord, sourceRecords } from "./records.ts";
import { type Storage, io } from "./storage.ts";
import { acquireTransport } from "./transport.ts";
import { containedPath } from "./tree.ts";
import type { MaterializeOptions, NpmPin, SourceSnapshot, SourceStoreOptions } from "./types.ts";

export const npmAcquisition = (
  options: SourceStoreOptions,
  storage: Storage,
  archives: ReturnType<typeof archiveAcquisition>,
) => {
  const records = sourceRecords(options.stateStore);
  const transport = () => {
    if (options.transports.npmRegistry === undefined)
      throw new SourceAcquisitionError({
        message: "Npm registry transport is unavailable.",
        source: "npm",
        kind: "fetch-failed",
        remediation: "Provide an authenticated npm registry transport.",
      });
    return options.transports.npmRegistry;
  };
  const registryFor = (name: string, supplied?: string) =>
    Effect.tryPromise({
      try: async () => {
        const registry = new URL(supplied ?? (await transport().registryFor(name)));
        registry.username = "";
        registry.password = "";
        return registry.href;
      },
      catch: (cause) => acquisitionError("fetch-failed", name, cause),
    });
  const resolveNpm = Effect.fn("SourceSession.resolveNpm")(function* (locator: {
    readonly name: string;
    readonly selector?: string;
  }) {
    const spec = `${locator.name}${locator.selector === undefined ? "" : `@${locator.selector}`}`;
    yield* Effect.try({
      try: () => parseNpmPackageSpec(spec),
      catch: (cause) => acquisitionError("invalid-locator", spec, cause),
    });
    const registry = yield* registryFor(locator.name).pipe(
      Effect.mapError(
        (error) => new SourceAcquisitionError({ ...error, message: error.message, phase: "metadata" }),
      ),
    );
    const packument = yield* acquireTransport(spec, (signal) =>
      transport().packument(locator.name, { signal }),
    ).pipe(
      Effect.mapError(
        (error) => new SourceAcquisitionError({ ...error, message: error.message, phase: "metadata" }),
      ),
    );
    if (packument === undefined)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `npm package "${locator.name}" was not found in the registry.`,
          source: spec,
          kind: "not-found",
          remediation: "Check the package name (and scope) and retry lando init.",
        }),
      );
    const version = yield* Effect.try({
      try: () => resolveNpmPackageVersion(packument, locator.selector, spec),
      catch: (cause) => acquisitionError("version-not-found", spec, cause),
    });
    const dist = packument.versions?.[version]?.dist;
    if (dist === undefined || dist.tarball.trim() === "")
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `npm package "${locator.name}@${version}" has no published tarball URL.`,
          source: spec,
          kind: "version-not-found",
          remediation: "Pick a published version of this package, then retry lando init.",
        }),
      );
    return { kind: "npm", name: locator.name, version, registry, dist } satisfies NpmPin;
  });
  const openIndexed = (
    coordinate: { readonly name: string; readonly version: string },
    registry: string,
    record: typeof NpmIndexRecord.Type,
  ) =>
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
  // Version-only include pins are verified by their fragment checksum, so a warm
  // load may use the same name@version cached from any registry, most recent first.
  const lookupAnyRegistry = Effect.fn("SourceSession.lookupNpmAnyRegistry")(function* (coordinate: {
    readonly name: string;
    readonly version: string;
  }) {
    const candidates: { readonly record: typeof NpmIndexRecord.Type; readonly usedAt: number }[] = [];
    for (const row of yield* metadata(storage.root, options.stateStore)) {
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
  const lookupNpm = Effect.fn("SourceSession.lookupNpm")(function* (coordinate: {
    readonly name: string;
    readonly version: string;
    readonly registry?: string;
  }) {
    const resolved = yield* Effect.result(registryFor(coordinate.name, coordinate.registry));
    if (resolved._tag === "Failure") {
      const fallback = yield* lookupAnyRegistry(coordinate);
      return fallback ?? (yield* Effect.fail(resolved.failure));
    }
    const registry = resolved.success;
    const bucket = yield* records.npm(registry, coordinate.name, coordinate.version);
    const record = yield* bucket.get.pipe(
      Effect.mapError((error) => acquisitionError("cache", coordinate.name, error)),
    );
    const exact =
      record === null ||
      record.name !== coordinate.name ||
      record.version !== coordinate.version ||
      record.registry !== displaySource(registry)
        ? undefined
        : yield* openIndexed(coordinate, registry, record);
    return exact ?? (yield* lookupAnyRegistry(coordinate));
  });
  const materializeNpm = Effect.fn("SourceSession.materializeNpm")(function* (
    pin: NpmPin,
    acquisition: MaterializeOptions = {},
  ): Effect.fn.Return<SourceSnapshot<NpmPin>, SourceAcquisitionError> {
    const source = `${pin.name}@${pin.version}`;
    if ((pin.dist.integrity?.trim() ?? "") === "" && (pin.dist.shasum?.trim() ?? "") === "") {
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `npm tarball ${source} has no verifiable integrity or shasum.`,
          source,
          kind: "integrity-missing",
          remediation: "Publish the package with dist.integrity or dist.shasum before acquiring it.",
        }),
      );
    }
    const bucket = yield* records.npm(pin.registry, pin.name, pin.version);
    const previous = yield* bucket.get.pipe(
      Effect.mapError((error) => acquisitionError("cache", source, error)),
    );
    if (
      !acquisition.repair &&
      previous !== null &&
      previous.registry === displaySource(pin.registry) &&
      previous.name === pin.name &&
      previous.version === pin.version &&
      previous.integrity === pin.dist.integrity &&
      previous.shasum === pin.dist.shasum
    ) {
      const snapshot = yield* storage.open({ kind: "archive", sha256: previous.sha256 }, pin);
      if (snapshot !== undefined) return snapshot;
    }
    if (acquisition.network === false)
      return yield* Effect.fail(
        new SourceAcquisitionError({
          message: `Npm source ${source} is not cached.`,
          source,
          kind: "offline-miss",
          remediation: "Acquire this package with network access first.",
        }),
      );
    const bytes = yield* acquireTransport(source, (signal) =>
      transport().tarball({ packageName: pin.name, dist: pin.dist, signal }),
    ).pipe(
      Effect.mapError(
        (error) => new SourceAcquisitionError({ ...error, message: error.message, phase: "download" }),
      ),
    );
    const integrity = checkNpmPackageDistIntegrity(bytes, pin.dist);
    switch (integrity.status) {
      case "unverifiable":
        return yield* Effect.fail(
          new SourceAcquisitionError({
            message: `npm tarball ${source} has no verifiable integrity or shasum.`,
            source,
            kind: "integrity-missing",
            remediation: "Publish the package with dist.integrity or dist.shasum before acquiring it.",
          }),
        );
      case "mismatch":
        return yield* Effect.fail(
          new SourceAcquisitionError({
            message: `npm tarball ${source} ${integrity.description}`,
            source,
            kind: "integrity-mismatch",
            remediation: integrity.remediation,
          }),
        );
      case "verified":
        break;
      default: {
        const exhaustive: never = integrity;
        return exhaustive;
      }
    }
    const sha256 = sha256Hex(bytes);
    const cached = acquisition.repair ? undefined : yield* storage.open({ kind: "archive", sha256 }, pin);
    const snapshot = cached ?? {
      ...(yield* archives.publishBytes({
        bytes,
        sha256,
        source: pin.dist.tarball,
        repair: acquisition.repair === true,
      })),
      pin,
    };
    yield* storage.locked(
      bucket.set({
        name: pin.name,
        version: pin.version,
        registry: displaySource(pin.registry),
        sha256,
        ...(pin.dist.integrity === undefined ? {} : { integrity: pin.dist.integrity }),
        ...(pin.dist.shasum === undefined ? {} : { shasum: pin.dist.shasum }),
      }),
    );
    return snapshot;
  });
  const acquireNpm = Effect.fn("SourceSession.acquireNpm")(function* (
    locator: { readonly name: string; readonly selector?: string },
    acquisition?: MaterializeOptions,
  ) {
    return yield* materializeNpm(yield* resolveNpm(locator), acquisition);
  });
  return { resolveNpm, lookupNpm, materializeNpm, acquireNpm };
};
