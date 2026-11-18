import { createHash } from "node:crypto";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import type { archiveAcquisition } from "./acquire-archive.ts";
import { SourceAcquisitionError, acquisitionError, displaySource } from "./errors.ts";
import { checkNpmPackageDistIntegrity } from "./integrity.ts";
import { parseNpmPackageSpec, resolveNpmPackageVersion } from "./npm.ts";
import { verifyAuthoredNpmDigest, verifyNpmFile } from "./npm-authored-integrity.ts";
import { npmCache } from "./npm-cache.ts";
import type { Storage } from "./storage.ts";
import { acquireTransport } from "./transport.ts";
import type {
  ExactNpmSource,
  MaterializeOptions,
  NpmAuthoredIntegrity,
  NpmPin,
  SourceSnapshot,
  SourceStoreOptions,
} from "./types.ts";

const missingIntegrity = (source: string) =>
  new SourceAcquisitionError({
    message: `npm tarball ${source} has no verifiable integrity or shasum.`,
    source,
    kind: "integrity-missing",
    remediation: "Publish the package with dist.integrity or dist.shasum before acquiring it.",
  });

const metadataFailure = (error: SourceAcquisitionError) =>
  new SourceAcquisitionError({ ...error, message: error.message, phase: "metadata" });

export const npmAcquisition = (
  options: SourceStoreOptions,
  storage: Storage,
  archives: ReturnType<typeof archiveAcquisition>,
) => {
  const cache = npmCache(options.stateStore, storage);
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
    readonly registry?: string;
  }) {
    const spec = `${locator.name}${locator.selector === undefined ? "" : `@${locator.selector}`}`;
    yield* Effect.try({
      try: () => parseNpmPackageSpec(spec),
      catch: (cause) => acquisitionError("invalid-locator", spec, cause),
    });
    const registry = yield* registryFor(locator.name, locator.registry).pipe(mapFailures(metadataFailure));
    const packument = yield* acquireTransport(spec, (signal) =>
      transport().packument(locator.name, { signal }),
    ).pipe(mapFailures(metadataFailure));
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
  const lookupNpm = Effect.fn("SourceSession.lookupNpm")(function* (coordinate: {
    readonly name: string;
    readonly version: string;
    readonly registry?: string;
  }) {
    const resolved = yield* Effect.result(registryFor(coordinate.name, coordinate.registry));
    if (resolved._tag === "Failure") {
      const fallback = yield* cache.lookupAnyRegistry(coordinate);
      return fallback ?? (yield* Effect.fail(resolved.failure));
    }
    const exact = yield* cache.lookupExact(
      { name: coordinate.name, version: coordinate.version },
      resolved.success,
    );
    return exact ?? (yield* cache.lookupAnyRegistry(coordinate));
  });
  const materializeNpm = Effect.fn("SourceSession.materializeNpm")(function* (
    pin: NpmPin,
    acquisition: MaterializeOptions & {
      readonly exact?: true;
      readonly integrity?: NpmAuthoredIntegrity;
    } = {},
  ): Effect.fn.Return<SourceSnapshot<NpmPin>, SourceAcquisitionError> {
    const source = `${pin.name}@${pin.version}`;
    if ((pin.dist.integrity?.trim() ?? "") === "" && (pin.dist.shasum?.trim() ?? "") === "") {
      return yield* Effect.fail(missingIntegrity(source));
    }
    const bucket = yield* cache.index(pin.registry, pin.name, pin.version);
    const previous = yield* bucket.get.pipe(mapFailures((error) => acquisitionError("cache", source, error)));
    if (acquisition.exact !== true) {
      const snapshot = yield* cache.openMaterialized(pin, previous, acquisition.repair === true);
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
      mapFailures(
        (error) => new SourceAcquisitionError({ ...error, message: error.message, phase: "download" }),
      ),
    );
    const integrity = checkNpmPackageDistIntegrity(bytes, pin.dist);
    switch (integrity.status) {
      case "unverifiable":
        return yield* Effect.fail(missingIntegrity(source));
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
    const tarballDigests = {
      sha224: createHash("sha224").update(bytes).digest("hex"),
      sha384: createHash("sha384").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
    const authored = acquisition.integrity;
    if (authored !== undefined && authored.file === undefined) {
      yield* verifyAuthoredNpmDigest(
        source,
        authored,
        authored.algorithm === "sha256" ? sha256 : tarballDigests[authored.algorithm],
      );
    }
    const verifyTree =
      authored?.file === undefined ? undefined : verifyNpmFile(source, { ...authored, file: authored.file });
    const cached = yield* storage.open({ kind: "archive", sha256 }, pin, {
      verify: acquisition.repair === true,
    });
    if (cached !== undefined && verifyTree !== undefined) yield* verifyTree(cached.root);
    const snapshot = cached ?? {
      ...(yield* archives.publishBytes({
        bytes,
        sha256,
        source: pin.dist.tarball,
        repair: acquisition.repair === true,
        ...(verifyTree === undefined ? {} : { verifyTree }),
      })),
      pin,
    };
    yield* storage.sessionLocked(
      bucket.set({
        name: pin.name,
        version: pin.version,
        registry: displaySource(pin.registry),
        sha256,
        tarballDigests,
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
  const acquireExactNpm = Effect.fn("SourceSession.acquireExactNpm")(function* (
    coordinate: ExactNpmSource,
    acquisition: { readonly network?: boolean } = {},
  ) {
    const { name, version, integrity } = coordinate;
    const source = `${name}@${version}`;
    if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/iu.test(version)) {
      return yield* new SourceAcquisitionError({
        kind: "invalid-locator",
        source,
        message: `Expected an exact npm version for ${source}.`,
        remediation: "Choose an exact published npm version.",
      });
    }
    const registry = yield* registryFor(name);
    const cached = yield* cache.lookupExact(coordinate, registry);
    if (cached !== undefined) return cached;
    if (acquisition.network === false) {
      return yield* new SourceAcquisitionError({
        kind: "offline-miss",
        source,
        message: `Exact npm source ${source} is not cached with the required integrity.`,
        remediation: "Acquire this exact package with network access once.",
      });
    }
    const pin = yield* resolveNpm({ name, selector: version, registry });
    if (pin.version !== version) {
      return yield* new SourceAcquisitionError({
        kind: "version-not-found",
        source,
        message: `The registry did not publish exact version ${source}.`,
        remediation: "Choose an exact published npm version.",
      });
    }
    return yield* materializeNpm(pin, { exact: true, ...(integrity === undefined ? {} : { integrity }) });
  });
  return { resolveNpm, lookupNpm, materializeNpm, acquireNpm, acquireExactNpm };
};
