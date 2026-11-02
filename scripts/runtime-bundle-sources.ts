import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Schema } from "effect";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PROVIDER_DIR = resolve(REPO_ROOT, "plugins", "provider-lando");

export const RUNTIME_BUNDLE_SOURCES_PATH = join(PROVIDER_DIR, "runtime-bundle-sources.json");

export const LinuxPodmanSourceBuild = "podman-linux-native" as const;
export const LinuxNetavarkSourceBuild = "netavark-linux-native" as const;
export const LinuxAardvarkDnsSourceBuild = "aardvark-dns-linux-native" as const;
export const LinuxPasstSourceBuild = "passt-linux-native" as const;

const linuxHostKeys = new Set(["linux-x64", "linux-arm64"]);
const uidmapInstallNames = new Set(["bin/newuidmap", "bin/newgidmap"]);

const Sha256 = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  Schema.check(
    Schema.makeFilter((value) =>
      /^0+$/u.test(value) ? "placeholder (all-zero) sha256 is not allowed" : undefined,
    ),
  ),
);

const HttpsUrl = Schema.String.pipe(Schema.check(Schema.isPattern(/^https:\/\//u)));
const SafeName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)));
const RuntimeVersion = SafeName;

const License = Schema.Struct({
  spdx: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  source: HttpsUrl,
  texts: Schema.Array(
    Schema.Struct({
      url: HttpsUrl,
      sha256: Sha256,
      file: SafeName,
    }),
  ).pipe(Schema.check(Schema.isMinLength(1))),
});

const RuntimeBundleSourceInput = Schema.Struct({
  name: Schema.Literals(["source", "vendor"]),
  url: HttpsUrl,
  sha256: Sha256,
  archive: Schema.Literals(["tar.gz", "tar.xz"]),
});

const RuntimeBundleSourceOutput = Schema.Struct({
  source: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  installName: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u))),
  mode: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

const PositiveSize = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0)));

const SafeInstallName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)));

const isSafeDebMember = (value: string): boolean => {
  if (value.length === 0 || value.startsWith("/") || value.includes(String.fromCharCode(92))) return false;
  const parts = value.split("/");
  return parts.every(
    (part) => part.length > 0 && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/u.test(part),
  );
};

const SafeDebMember = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(
    Schema.makeFilter((value: string) =>
      isSafeDebMember(value) ? undefined : "Debian member must be a relative path without . or .. segments",
    ),
  ),
);

const RuntimeBundleBinaryComponent = Schema.Struct({
  license: License,
  name: SafeName,
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  url: HttpsUrl,
  sha256: Sha256,
  archive: Schema.Literals(["none", "gz", "tar.gz", "zip"]),
  member: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)))),
  installName: SafeInstallName,
  mode: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  sourceBuild: Schema.optionalKey(Schema.Literal(LinuxPodmanSourceBuild)),
});

/** Exact upstream/Debian source archive pin for a Debian binary component (not the .deb). */
const RuntimeBundleDebianSourcePin = Schema.Struct({
  url: HttpsUrl,
  sha256: Sha256,
  sizeBytes: PositiveSize,
});

/** Pinned Debian package that yields one verified static ELF member into the bundle. */
const RuntimeBundleDebianComponent = Schema.Struct({
  license: License,
  name: SafeName,
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  archive: Schema.Literal("deb"),
  url: HttpsUrl,
  sha256: Sha256,
  sizeBytes: PositiveSize,
  /** Actual source archive (orig/tarball), never the binary .deb. */
  source: RuntimeBundleDebianSourcePin,
  member: SafeDebMember,
  binarySha256: Sha256,
  binarySizeBytes: PositiveSize,
  elfMachine: Schema.Literals([62, 183]),
  installName: SafeDebMember,
  mode: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

const RuntimeBundleSourceComponent = Schema.Struct({
  license: License,
  name: SafeName,
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  sourceBuild: Schema.Literals([
    LinuxNetavarkSourceBuild,
    LinuxAardvarkDnsSourceBuild,
    LinuxPasstSourceBuild,
  ]),
  inputs: Schema.Array(RuntimeBundleSourceInput).pipe(Schema.check(Schema.isMinLength(1))),
  outputs: Schema.Array(RuntimeBundleSourceOutput).pipe(Schema.check(Schema.isMinLength(1))),
});

const RuntimeBundleComponent = Schema.Union([
  RuntimeBundleBinaryComponent,
  RuntimeBundleDebianComponent,
  RuntimeBundleSourceComponent,
]);

const RuntimeBundleGroup = Schema.Struct({
  components: Schema.Array(RuntimeBundleComponent).pipe(Schema.check(Schema.isMinLength(1))),
});

export const RuntimeBundleSources = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: RuntimeVersion,
  hostProvidedHelpers: Schema.optionalKey(Schema.Array(Schema.Literals(["newuidmap", "newgidmap"]))),
  bundles: Schema.Record(Schema.String, RuntimeBundleGroup),
});

export type RuntimeBundleSources = Schema.Schema.Type<typeof RuntimeBundleSources>;
export type RuntimeBundleComponent = Schema.Schema.Type<typeof RuntimeBundleComponent>;
export type RuntimeBundleBinaryComponent = Schema.Schema.Type<typeof RuntimeBundleBinaryComponent>;
export type RuntimeBundleDebianComponent = Schema.Schema.Type<typeof RuntimeBundleDebianComponent>;

const decodeSources = Schema.decodeUnknownSync(RuntimeBundleSources);

export const isLinuxRuntimeBundle = (hostKey: string): boolean => linuxHostKeys.has(hostKey);

// The version must appear as a whole token: `2.2.1` must not match `v2.2.10` or `v2.2.1.5`.
const urlNamesVersion = (url: string, version: string): boolean => {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![0-9A-Za-z.])v?${escaped}(?![0-9A-Za-z]|\\.[0-9])`, "u").test(url);
};

/**
 * Debian binary package versions carry packaging and binary-NMU suffixes
 * (`0.2.1-2+b14`). License/source URLs commonly name only the upstream token
 * (`0.2.1`) or the source package version (`0.2.1-2`). Accept those compatible
 * prefixes so notices can point at the actual source archive rather than the .deb.
 */
const debianCompatibleVersionTokens = (version: string): readonly string[] => {
  const tokens: string[] = [version];
  const withoutBinaryNmu = version.replace(/\+b\d+$/u, "");
  if (withoutBinaryNmu !== version) tokens.push(withoutBinaryNmu);
  // Conventional Debian `upstream-revision` form with a dotted upstream version.
  const debianSource = withoutBinaryNmu.match(/^(\d+(?:\.\d+)*)-\d+$/u);
  if (debianSource?.[1] !== undefined) tokens.push(debianSource[1]);
  return tokens;
};

const urlIdentifiesPinnedVersion = (url: string, version: string): boolean =>
  debianCompatibleVersionTokens(version).some((token) => urlNamesVersion(url, token));

const componentPinnedUrls = (component: RuntimeBundleComponent): readonly string[] => {
  if ("inputs" in component) return component.inputs.map((input) => input.url);
  if ("archive" in component && component.archive === "deb") {
    return [component.url, component.source.url];
  }
  return [component.url];
};

const validateComponent = (hostKey: string, component: RuntimeBundleComponent): void => {
  const pinnedUrls = componentPinnedUrls(component);
  if (
    !pinnedUrls.includes(component.license.source) &&
    !urlIdentifiesPinnedVersion(component.license.source, component.version)
  ) {
    throw new Error(
      `assemble-runtime-bundle: ${component.name} license source must identify pinned version ${component.version}`,
    );
  }
  const files = component.license.texts.map((text) => text.file);
  if (new Set(files).size !== files.length) {
    throw new Error(`assemble-runtime-bundle: ${component.name} has duplicate license filenames`);
  }
  if ("installName" in component && uidmapInstallNames.has(component.installName)) {
    throw new Error("assemble-runtime-bundle: newuidmap/newgidmap must not be bundled");
  }
  if ("archive" in component && component.archive === "deb") {
    if (!isLinuxRuntimeBundle(hostKey)) {
      throw new Error(
        `assemble-runtime-bundle: Debian components are only valid on Linux host keys (${hostKey}/${component.name})`,
      );
    }
    const expectedMachine = hostKey === "linux-x64" ? 62 : hostKey === "linux-arm64" ? 183 : undefined;
    if (expectedMachine !== undefined && component.elfMachine !== expectedMachine) {
      throw new Error(
        `assemble-runtime-bundle: ${component.name} elfMachine ${component.elfMachine} does not match ${hostKey}`,
      );
    }
    // license.source must identify the actual source archive, not the binary .deb.
    if (component.license.source === component.url) {
      throw new Error(
        `assemble-runtime-bundle: ${component.name} license.source must point at the source archive, not the binary .deb`,
      );
    }
    if (
      component.license.source !== component.source.url &&
      !urlIdentifiesPinnedVersion(component.license.source, component.version)
    ) {
      throw new Error(
        `assemble-runtime-bundle: ${component.name} license.source must match the pinned source archive or name a compatible version`,
      );
    }
  }
  if ("outputs" in component) {
    for (const input of component.inputs) {
      if (input.name === "vendor" && input.archive !== "tar.gz") {
        throw new Error("assemble-runtime-bundle: vendor source-build inputs must use tar.gz archives");
      }
    }
    for (const output of component.outputs) {
      if (uidmapInstallNames.has(output.installName)) {
        throw new Error("assemble-runtime-bundle: newuidmap/newgidmap must not be bundled");
      }
    }
  }
  if (!isLinuxRuntimeBundle(hostKey)) return;
  const installsPodman =
    component.name === "podman" || ("installName" in component && component.installName === "bin/podman");
  if (
    installsPodman &&
    (!("installName" in component) ||
      !("sourceBuild" in component) ||
      component.sourceBuild !== LinuxPodmanSourceBuild)
  ) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman must be source-built with ${LinuxPodmanSourceBuild}; remote-static and other binary pins are forbidden (${hostKey})`,
    );
  }
  if (
    (component.name === "netavark" || component.name === "aardvark-dns") &&
    "url" in component &&
    !("inputs" in component)
  ) {
    throw new Error(`assemble-runtime-bundle: Linux ${component.name} must be source-built (${hostKey})`);
  }
};

const validateRuntimeBundleSources = (sources: RuntimeBundleSources): RuntimeBundleSources => {
  for (const [hostKey, group] of Object.entries(sources.bundles)) {
    for (const component of group.components) validateComponent(hostKey, component);
  }
  return sources;
};

export const parseRuntimeBundleSources = (value: unknown): RuntimeBundleSources =>
  validateRuntimeBundleSources(decodeSources(value));

export const readRuntimeBundleSources = async (): Promise<RuntimeBundleSources> =>
  parseRuntimeBundleSources(JSON.parse(await readFile(RUNTIME_BUNDLE_SOURCES_PATH, "utf8")));
