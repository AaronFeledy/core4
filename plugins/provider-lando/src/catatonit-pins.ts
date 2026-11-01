import { basename, join } from "node:path";

import { Schema } from "effect";

import sourceManifestData from "../runtime-bundle-sources.json" with { type: "json" };

/** Exact published runtime marker that may receive the temporary Debian helper bridge. */
export const LEGACY_NATIVE_INIT_BRIDGE_VERSION = "0.1.7" as const;

/** Installation version marker shared with runtime-extract. */
export const RUNTIME_INSTALLED_VERSION_MARKER = ".runtime-installed-version" as const;

/** Bridge completion receipt written last after helper + notices. */
export const CATATONIT_IDENTITY_RECEIPT = ".catatonit.identity" as const;

const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const Size = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)));
const HttpsUrl = Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//u)));
const SafeName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)));
const SourcePin = Schema.Struct({ url: HttpsUrl, sha256: Digest, sizeBytes: Size });

const LicenseText = Schema.Struct({
  file: SafeName,
  url: HttpsUrl,
  sha256: Digest,
});

const License = Schema.Struct({
  spdx: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  source: HttpsUrl,
  texts: Schema.Array(LicenseText).pipe(Schema.check(Schema.isMinLength(1))),
});

const DebianCatatonitComponent = Schema.Struct({
  source: SourcePin,
  name: Schema.Literal("catatonit"),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  archive: Schema.Literal("deb"),
  url: HttpsUrl,
  sha256: Digest,
  sizeBytes: Size,
  member: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  binarySha256: Digest,
  binarySizeBytes: Size,
  elfMachine: Schema.Literals([62, 183]),
  installName: Schema.Literal("bin/catatonit"),
  mode: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  license: License,
});

const BundleGroup = Schema.Struct({
  components: Schema.Array(Schema.Unknown),
});

const SourceManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  bundles: Schema.Struct({
    "linux-x64": BundleGroup,
    "linux-arm64": BundleGroup,
  }),
});

const Package = Schema.Struct({
  source: SourcePin,
  url: HttpsUrl,
  filename: SafeName,
  sha256: Digest,
  sizeBytes: Size,
  binarySha256: Digest,
  binarySizeBytes: Size,
  elfMachine: Schema.Literals([62, 183]),
  member: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  license: License,
});

/** Complete pin identity persisted in `.catatonit.identity` after bridge notices. */
export const CatatonitIdentityReceipt = Schema.Struct({
  source: SourcePin,
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("bridge"),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  packageSha256: Digest,
  packageSizeBytes: Size,
  binarySha256: Digest,
  binarySizeBytes: Size,
  elfMachine: Schema.Literals([62, 183]),
  member: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  license: Schema.Struct({
    spdx: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    source: HttpsUrl,
    texts: Schema.Array(
      Schema.Struct({
        file: SafeName,
        sha256: Digest,
      }),
    ).pipe(Schema.check(Schema.isMinLength(1))),
  }),
});

export type CatatonitPackage = Schema.Schema.Type<typeof Package>;
export type CatatonitIdentity = Schema.Schema.Type<typeof CatatonitIdentityReceipt>;

const decodeSource = Schema.decodeUnknownSync(SourceManifest);
const decodeComponent = Schema.decodeUnknownSync(DebianCatatonitComponent);
export const decodeCatatonitIdentity = Schema.decodeUnknownSync(CatatonitIdentityReceipt);

const filenameFromUrl = (url: string): string => {
  const name = basename(new URL(url).pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(name)) {
    throw new Error(`Catatonit pin URL does not yield a safe filename: ${url}`);
  }
  return name;
};

const packageFromComponent = (
  component: Schema.Schema.Type<typeof DebianCatatonitComponent>,
): CatatonitPackage => ({
  source: component.source,
  url: component.url,
  filename: filenameFromUrl(component.url),
  sha256: component.sha256,
  sizeBytes: component.sizeBytes,
  binarySha256: component.binarySha256,
  binarySizeBytes: component.binarySizeBytes,
  elfMachine: component.elfMachine,
  member: component.member,
  version: component.version,
  license: component.license,
});

const findCatatonitComponent = (components: ReadonlyArray<unknown>): CatatonitPackage => {
  for (const entry of components) {
    if (typeof entry !== "object" || entry === null || !("name" in entry) || entry.name !== "catatonit") {
      continue;
    }
    return packageFromComponent(decodeComponent(entry));
  }
  throw new Error("runtime-bundle-sources.json is missing a Linux catatonit Debian component.");
};

const sourceManifest = decodeSource(sourceManifestData);
const packages = {
  x64: findCatatonitComponent(sourceManifest.bundles["linux-x64"].components),
  arm64: findCatatonitComponent(sourceManifest.bundles["linux-arm64"].components),
} as const;

export const CATATONIT_MANIFEST = {
  schemaVersion: 1 as const,
  toolVersion: packages.x64.version,
  /** Recipe version that ships catatonit inside the Linux runtime payload. */
  recipeRuntimeVersion: sourceManifest.runtimeVersion,
  packages,
} as const;

export const managedCatatonitPath = (runtimeBinDir: string): string => join(runtimeBinDir, "catatonit");

export const managedCatatonitNoticesDir = (runtimeBinDir: string): string =>
  join(runtimeBinDir, "licenses", "catatonit");

export const runtimeInstalledVersionPath = (runtimeBinDir: string): string =>
  join(runtimeBinDir, RUNTIME_INSTALLED_VERSION_MARKER);

export const managedCatatonitIdentityPath = (runtimeBinDir: string): string =>
  join(runtimeBinDir, CATATONIT_IDENTITY_RECEIPT);

/** True when the recipe version is the helper-bearing Linux payload (not the 0.1.7 bridge). */
export const runtimeRecipeIncludesNativeInitHelper = (version: string): boolean =>
  version === CATATONIT_MANIFEST.recipeRuntimeVersion;

export const catatonitPackageForArch = (arch: string): CatatonitPackage | undefined => {
  if (arch === "x64" || arch === "amd64") return CATATONIT_MANIFEST.packages.x64;
  if (arch === "arm64") return CATATONIT_MANIFEST.packages.arm64;
  return undefined;
};

export const buildCatatonitIdentity = (pkg: CatatonitPackage): CatatonitIdentity =>
  decodeCatatonitIdentity({
    source: pkg.source,
    schemaVersion: 1,
    kind: "bridge",
    version: pkg.version,
    packageSha256: pkg.sha256,
    packageSizeBytes: pkg.sizeBytes,
    binarySha256: pkg.binarySha256,
    binarySizeBytes: pkg.binarySizeBytes,
    elfMachine: pkg.elfMachine,
    member: pkg.member,
    license: {
      spdx: pkg.license.spdx,
      source: pkg.license.source,
      texts: pkg.license.texts.map((text) => ({ file: text.file, sha256: text.sha256 })),
    },
  });

export const serializeCatatonitIdentity = (identity: CatatonitIdentity): string =>
  `${JSON.stringify(identity, null, 2)}\n`;

export const catatonitIdentityMatchesPackage = (
  identity: CatatonitIdentity,
  pkg: CatatonitPackage,
): boolean => {
  return serializeCatatonitIdentity(identity) === serializeCatatonitIdentity(buildCatatonitIdentity(pkg));
};
