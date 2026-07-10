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
  Schema.pattern(/^[0-9a-f]{64}$/u),
  Schema.filter((value) =>
    /^0+$/u.test(value) ? "placeholder (all-zero) sha256 is not allowed" : undefined,
  ),
);

const HttpsUrl = Schema.String.pipe(Schema.pattern(/^https:\/\//u));
const RuntimeVersion = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u));

const RuntimeBundleSourceInput = Schema.Struct({
  name: Schema.Literal("source", "vendor"),
  url: HttpsUrl,
  sha256: Sha256,
  archive: Schema.Literal("tar.gz", "tar.xz"),
});

const RuntimeBundleSourceOutput = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  installName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)),
  mode: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
});

const RuntimeBundleBinaryComponent = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.String.pipe(Schema.minLength(1)),
  url: HttpsUrl,
  sha256: Sha256,
  archive: Schema.Literal("none", "gz", "tar.gz", "zip"),
  member: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  installName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u)),
  mode: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  sourceBuild: Schema.optional(Schema.Literal(LinuxPodmanSourceBuild)),
});

const RuntimeBundleSourceComponent = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.String.pipe(Schema.minLength(1)),
  sourceBuild: Schema.Literal(LinuxNetavarkSourceBuild, LinuxAardvarkDnsSourceBuild, LinuxPasstSourceBuild),
  inputs: Schema.Array(RuntimeBundleSourceInput).pipe(Schema.minItems(1)),
  outputs: Schema.Array(RuntimeBundleSourceOutput).pipe(Schema.minItems(1)),
});

const RuntimeBundleComponent = Schema.Union(RuntimeBundleBinaryComponent, RuntimeBundleSourceComponent);

const RuntimeBundleGroup = Schema.Struct({
  components: Schema.Array(RuntimeBundleComponent).pipe(Schema.minItems(1)),
});

export const RuntimeBundleSources = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeVersion: RuntimeVersion,
  hostProvidedHelpers: Schema.optional(Schema.Array(Schema.Literal("newuidmap", "newgidmap"))),
  bundles: Schema.Record({ key: Schema.String, value: RuntimeBundleGroup }),
});

export type RuntimeBundleSources = Schema.Schema.Type<typeof RuntimeBundleSources>;
export type RuntimeBundleComponent = Schema.Schema.Type<typeof RuntimeBundleComponent>;
export type RuntimeBundleBinaryComponent = Schema.Schema.Type<typeof RuntimeBundleBinaryComponent>;

const decodeSources = Schema.decodeUnknownSync(RuntimeBundleSources);

export const isLinuxRuntimeBundle = (hostKey: string): boolean => linuxHostKeys.has(hostKey);

const validateComponent = (hostKey: string, component: RuntimeBundleComponent): void => {
  if ("installName" in component && uidmapInstallNames.has(component.installName)) {
    throw new Error("assemble-runtime-bundle: newuidmap/newgidmap must not be bundled");
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
  if (installsPodman && (!("installName" in component) || component.sourceBuild !== LinuxPodmanSourceBuild)) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman must be source-built with ${LinuxPodmanSourceBuild}; remote-static and other binary pins are forbidden (${hostKey})`,
    );
  }
  if ((component.name === "netavark" || component.name === "aardvark-dns") && "url" in component) {
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
