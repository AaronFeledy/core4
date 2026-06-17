import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path/posix";

export type ReleaseSbomArtifactKind = "binary" | "library";

export interface ReleaseSbomArtifactInput {
  readonly kind: ReleaseSbomArtifactKind;
  readonly path: string;
}

export interface GenerateReleaseSbomsInput {
  readonly version: string;
  readonly manifestPath: string;
  readonly artifacts: ReadonlyArray<ReleaseSbomArtifactInput>;
}

interface ReleaseManifestSbomEntry {
  readonly path: string;
  readonly sha256: string;
}

interface ReleaseManifestArtifactEntry {
  readonly kind: ReleaseSbomArtifactKind;
  readonly path: string;
  readonly sha256: string;
  readonly sbom?: ReleaseManifestSbomEntry;
}

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly artifacts: Record<string, ReleaseManifestArtifactEntry>;
}

const repoPackageJson = new URL("../package.json", import.meta.url);
const corePackageJson = new URL("../core/package.json", import.meta.url);
const sdkPackageJson = new URL("../sdk/package.json", import.meta.url);
const artifactFormatError = "--artifact must be formatted as <binary|library>:<path>";

const normalizeManifestPath = (path: string): string => path.replace(/^\.\//, "");

const sha256File = async (path: string): Promise<string> => {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
};

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

const packageVersion = async (packageJsonUrl: URL, fallback: string): Promise<string> => {
  try {
    const parsed = JSON.parse(await readFile(packageJsonUrl, "utf8"));
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = parsed.version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback;
    throw error;
  }
  return fallback;
};

const sbomPathForArtifact = (artifactPath: string, version: string): string => {
  const normalized = normalizeManifestPath(artifactPath);
  const dir = dirname(normalized);
  const base = basename(normalized);
  const extension = base.endsWith(".exe") ? ".exe" : base.endsWith(".tgz") ? ".tgz" : "";
  const stem = extension === "" ? base : base.slice(0, -extension.length);
  const versionedStem = stem.endsWith(`-${version}`) ? stem : `${stem}-${version}`;
  const sbomBase = `${versionedStem}-sbom.cdx.json`;
  return dir === "." ? sbomBase : join(dir, sbomBase);
};

const assertObjectRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const readManifest = async (manifestPath: string): Promise<ReleaseManifest> => {
  try {
    const root = assertObjectRecord(JSON.parse(await readFile(manifestPath, "utf8")), "release manifest");
    const artifactsValue = root.artifacts;
    const artifactRecords =
      artifactsValue === undefined ? {} : assertObjectRecord(artifactsValue, "artifacts");
    const artifacts: Record<string, ReleaseManifestArtifactEntry> = {};

    for (const [name, value] of Object.entries(artifactRecords)) {
      const entry = assertObjectRecord(value, `artifact ${name}`);
      const kind = entry.kind;
      const path = entry.path;
      const sha256 = entry.sha256;
      if (
        (kind !== "binary" && kind !== "library") ||
        typeof path !== "string" ||
        typeof sha256 !== "string"
      ) {
        throw new Error(`artifact ${name} is not a release manifest artifact entry`);
      }
      const sbomValue = entry.sbom;
      const sbom =
        sbomValue === undefined ? undefined : assertObjectRecord(sbomValue, `artifact ${name} sbom`);
      artifacts[name] = {
        kind,
        path,
        sha256,
        ...(sbom === undefined
          ? {}
          : {
              sbom: {
                path: typeof sbom.path === "string" ? sbom.path : "",
                sha256: typeof sbom.sha256 === "string" ? sbom.sha256 : "",
              },
            }),
      };
    }

    return { schemaVersion: 1, artifacts };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: 1, artifacts: {} };
    }
    throw error;
  }
};

const assertGeneratedManifestSboms = async (manifest: ReleaseManifest): Promise<void> => {
  for (const [name, entry] of Object.entries(manifest.artifacts)) {
    const sbom = entry.sbom;
    if (sbom === undefined || sbom.path === "" || sbom.sha256 === "") {
      throw new Error(`Release manifest artifact ${name} lacks a matching SBOM.`);
    }
    const actualSbomSha = await sha256File(sbom.path);
    if (actualSbomSha !== sbom.sha256) {
      throw new Error(`Release manifest artifact ${name} has an SBOM checksum mismatch.`);
    }
  }
};

const readPackageComponents = async (
  releaseVersion: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const [coreVersion, sdkVersion] = await Promise.all([
    packageVersion(corePackageJson, releaseVersion),
    packageVersion(sdkPackageJson, releaseVersion),
  ]);
  return [
    { type: "library", name: "@lando/core", version: coreVersion },
    { type: "library", name: "@lando/sdk", version: sdkVersion },
    { type: "platform", name: "bun", version: Bun.version },
  ];
};

const buildCycloneDxSbom = async (
  artifact: ReleaseSbomArtifactInput,
  version: string,
  artifactSha256: string,
): Promise<Record<string, unknown>> => {
  const artifactName = basename(normalizeManifestPath(artifact.path));
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      tools: {
        components: [
          {
            type: "application",
            name: "@lando/core release-sbom",
            version: await packageVersion(repoPackageJson, version),
          },
        ],
      },
      component: {
        type: "file",
        name: artifactName,
        version,
        hashes: [{ alg: "SHA-256", content: artifactSha256 }],
        properties: [{ name: "lando:artifact-kind", value: artifact.kind }],
      },
    },
    components: await readPackageComponents(version),
  };
};

export const generateReleaseSboms = async ({
  version,
  manifestPath,
  artifacts,
}: GenerateReleaseSbomsInput): Promise<ReleaseManifest> => {
  const manifest = await readManifest(manifestPath);

  const nextArtifacts: Record<string, ReleaseManifestArtifactEntry> = { ...manifest.artifacts };
  for (const artifact of artifacts) {
    const normalizedPath = normalizeManifestPath(artifact.path);
    const artifactName = basename(normalizedPath);
    const artifactSha256 = await sha256File(artifact.path);
    const sbomPath = sbomPathForArtifact(artifact.path, version);
    const sbom = await buildCycloneDxSbom(artifact, version, artifactSha256);
    const sbomJson = `${JSON.stringify(sbom, null, 2)}\n`;
    await mkdir(dirname(sbomPath), { recursive: true });
    await writeFile(sbomPath, sbomJson, "utf8");
    nextArtifacts[artifactName] = {
      kind: artifact.kind,
      path: normalizedPath,
      sha256: artifactSha256,
      sbom: { path: normalizeManifestPath(sbomPath), sha256: sha256Text(sbomJson) },
    };
  }

  const nextManifest: ReleaseManifest = { schemaVersion: 1, artifacts: nextArtifacts };
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await assertGeneratedManifestSboms(nextManifest);
  return nextManifest;
};

const parseCliArgs = (args: ReadonlyArray<string>): GenerateReleaseSbomsInput => {
  let version: string | undefined;
  let manifestPath = "dist/update-manifest.json";
  const artifacts: Array<ReleaseSbomArtifactInput> = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const readValue = (label: string): string => {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${label} expects a value`);
      index += 1;
      return value;
    };

    if (arg === "--version") {
      version = readValue("--version");
      continue;
    }
    if (arg.startsWith("--version=")) {
      version = arg.slice("--version=".length);
      continue;
    }
    if (arg === "--manifest") {
      manifestPath = readValue("--manifest");
      continue;
    }
    if (arg.startsWith("--manifest=")) {
      manifestPath = arg.slice("--manifest=".length);
      continue;
    }
    if (arg === "--artifact") {
      artifacts.push(parseArtifact(readValue("--artifact")));
      continue;
    }
    if (arg.startsWith("--artifact=")) {
      artifacts.push(parseArtifact(arg.slice("--artifact=".length)));
      continue;
    }
    throw new Error(`Unknown release-sbom argument: ${arg}`);
  }

  if (version === undefined || version === "") throw new Error("--version is required");
  if (artifacts.length === 0) throw new Error("At least one --artifact is required");
  return { version, manifestPath, artifacts };
};

const parseArtifact = (value: string): ReleaseSbomArtifactInput => {
  const separator = value.indexOf(":");
  if (separator === -1) throw new Error(artifactFormatError);
  const kind = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if ((kind !== "binary" && kind !== "library") || path === "") {
    throw new Error(artifactFormatError);
  }
  return { kind, path };
};

if (import.meta.main) {
  await generateReleaseSboms(parseCliArgs(process.argv.slice(2)));
}
