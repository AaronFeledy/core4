import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path/posix";

export type ReleaseProvenanceArtifactKind = "binary" | "library";

export interface ReleaseProvenanceArtifactInput {
  readonly kind: ReleaseProvenanceArtifactKind;
  readonly path: string;
}

export interface GenerateReleaseProvenanceInput {
  readonly version: string;
  readonly manifestPath: string;
  readonly artifacts: ReadonlyArray<ReleaseProvenanceArtifactInput>;
  readonly env: Record<string, string | undefined>;
}

interface ReleaseManifestFileEntry {
  readonly path: string;
  readonly sha256: string;
}

interface ReleaseManifestArtifactEntry {
  readonly kind: ReleaseProvenanceArtifactKind;
  readonly path: string;
  readonly sha256: string;
  readonly sbom?: ReleaseManifestFileEntry;
  readonly provenance?: ReleaseManifestFileEntry;
}

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly artifacts: Record<string, ReleaseManifestArtifactEntry>;
}

const artifactFormatError = "--artifact must be formatted as <binary|library>:<path>";
const defaultRepository = "lando-community/core4";
const defaultWorkflowPath = ".github/workflows/release.yml";

const normalizeManifestPath = (path: string): string => path.replace(/^\.\//, "");

const sha256File = async (path: string): Promise<string> => {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
};

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

const provenancePathForArtifact = (artifactPath: string, version: string): string => {
  const normalized = normalizeManifestPath(artifactPath);
  const dir = dirname(normalized);
  const base = basename(normalized);
  const extension = base.endsWith(".exe") ? ".exe" : base.endsWith(".tgz") ? ".tgz" : "";
  const stem = extension === "" ? base : base.slice(0, -extension.length);
  const versionedStem = stem.endsWith(`-${version}`) ? stem : `${stem}-${version}`;
  const provenanceBase = `${versionedStem}-provenance.slsa.json`;
  return dir === "." ? provenanceBase : join(dir, provenanceBase);
};

export const releaseProvenancePathForArtifact = provenancePathForArtifact;

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
      const sbom = readManifestFileEntry(entry.sbom, `artifact ${name} sbom`);
      const provenance = readManifestFileEntry(entry.provenance, `artifact ${name} provenance`);
      artifacts[name] = {
        kind,
        path,
        sha256,
        ...(sbom === undefined ? {} : { sbom }),
        ...(provenance === undefined ? {} : { provenance }),
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

const readManifestFileEntry = (value: unknown, label: string): ReleaseManifestFileEntry | undefined => {
  if (value === undefined) return undefined;
  const entry = assertObjectRecord(value, label);
  return {
    path: typeof entry.path === "string" ? entry.path : "",
    sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
  };
};

const assertGeneratedManifestProvenance = async (manifest: ReleaseManifest): Promise<void> => {
  for (const [name, entry] of Object.entries(manifest.artifacts)) {
    const provenance = entry.provenance;
    if (provenance === undefined || provenance.path === "" || provenance.sha256 === "") {
      throw new Error(`Release manifest artifact ${name} lacks a matching SLSA provenance attestation.`);
    }
    const actualProvenanceSha = await sha256File(provenance.path);
    if (actualProvenanceSha !== provenance.sha256) {
      throw new Error(`Release manifest artifact ${name} has a SLSA provenance checksum mismatch.`);
    }
  }
};

const requireEnv = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`Missing ${name} for release provenance.`);
  return value;
};

const workflowPathFromRef = (workflowRef: string): string => {
  const marker = "/.github/workflows/";
  const markerIndex = workflowRef.indexOf(marker);
  if (markerIndex === -1) return defaultWorkflowPath;
  const workflowPath = workflowRef.slice(markerIndex + 1).split("@")[0];
  return workflowPath === "" ? defaultWorkflowPath : workflowPath;
};

const builderIdentity = (env: Record<string, string | undefined>, sourceRef: string): string => {
  const workflowRef = env.GITHUB_WORKFLOW_REF;
  if (workflowRef !== undefined && workflowRef !== "") return `https://github.com/${workflowRef}`;
  const repository = env.GITHUB_REPOSITORY ?? defaultRepository;
  return `https://github.com/${repository}/${defaultWorkflowPath}@${sourceRef}`;
};

const buildSlsaProvenance = ({
  artifact,
  artifactSha256,
  version,
  env,
}: {
  readonly artifact: ReleaseProvenanceArtifactInput;
  readonly artifactSha256: string;
  readonly version: string;
  readonly env: Record<string, string | undefined>;
}): Record<string, unknown> => {
  const sourceRef = requireEnv(env, "GITHUB_REF");
  const commitSha = requireEnv(env, "GITHUB_SHA");
  const repository = env.GITHUB_REPOSITORY ?? defaultRepository;
  const identity = builderIdentity(env, sourceRef);
  const workflowPath = workflowPathFromRef(
    env.GITHUB_WORKFLOW_REF ?? `${repository}/${defaultWorkflowPath}@${sourceRef}`,
  );
  const artifactName = basename(normalizeManifestPath(artifact.path));

  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: artifactName, digest: { sha256: artifactSha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/lando-community/core4/release/v1",
        externalParameters: { releaseVersion: version, sourceRef, workflowPath },
        resolvedDependencies: [
          { uri: `git+https://github.com/${repository}@${sourceRef}`, digest: { gitCommit: commitSha } },
        ],
      },
      runDetails: { builder: { id: identity } },
    },
  };
};

export const generateReleaseProvenance = async ({
  version,
  manifestPath,
  artifacts,
  env,
}: GenerateReleaseProvenanceInput): Promise<ReleaseManifest> => {
  const manifest = await readManifest(manifestPath);
  const nextArtifacts: Record<string, ReleaseManifestArtifactEntry> = { ...manifest.artifacts };

  for (const artifact of artifacts) {
    const normalizedPath = normalizeManifestPath(artifact.path);
    const artifactName = basename(normalizedPath);
    const artifactSha256 = await sha256File(artifact.path);
    const provenancePath = provenancePathForArtifact(artifact.path, version);
    const provenance = buildSlsaProvenance({ artifact, artifactSha256, version, env });
    const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceJson, "utf8");
    nextArtifacts[artifactName] = {
      kind: artifact.kind,
      path: normalizedPath,
      sha256: artifactSha256,
      ...(nextArtifacts[artifactName]?.sbom === undefined ? {} : { sbom: nextArtifacts[artifactName].sbom }),
      provenance: { path: normalizeManifestPath(provenancePath), sha256: sha256Text(provenanceJson) },
    };
  }

  const nextManifest: ReleaseManifest = { schemaVersion: 1, artifacts: nextArtifacts };
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await assertGeneratedManifestProvenance(nextManifest);
  return nextManifest;
};

const parseCliArgs = (args: ReadonlyArray<string>): GenerateReleaseProvenanceInput => {
  let version: string | undefined;
  let manifestPath = "dist/release-artifacts.json";
  const artifacts: Array<ReleaseProvenanceArtifactInput> = [];
  const env: Record<string, string | undefined> = { ...process.env };

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
    if (arg === "--source-ref") {
      env.GITHUB_REF = readValue("--source-ref");
      continue;
    }
    if (arg.startsWith("--source-ref=")) {
      env.GITHUB_REF = arg.slice("--source-ref=".length);
      continue;
    }
    if (arg === "--commit-sha") {
      env.GITHUB_SHA = readValue("--commit-sha");
      continue;
    }
    if (arg.startsWith("--commit-sha=")) {
      env.GITHUB_SHA = arg.slice("--commit-sha=".length);
      continue;
    }
    if (arg === "--repository") {
      env.GITHUB_REPOSITORY = readValue("--repository");
      continue;
    }
    if (arg.startsWith("--repository=")) {
      env.GITHUB_REPOSITORY = arg.slice("--repository=".length);
      continue;
    }
    if (arg === "--workflow-ref") {
      env.GITHUB_WORKFLOW_REF = readValue("--workflow-ref");
      continue;
    }
    if (arg.startsWith("--workflow-ref=")) {
      env.GITHUB_WORKFLOW_REF = arg.slice("--workflow-ref=".length);
      continue;
    }
    throw new Error(`Unknown release-provenance argument: ${arg}`);
  }

  if (version === undefined || version === "") throw new Error("--version is required");
  if (artifacts.length === 0) throw new Error("At least one --artifact is required");
  return { version, manifestPath, artifacts, env };
};

const parseArtifact = (value: string): ReleaseProvenanceArtifactInput => {
  const separator = value.indexOf(":");
  if (separator === -1) throw new Error(artifactFormatError);
  const kind = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if ((kind !== "binary" && kind !== "library") || path === "") throw new Error(artifactFormatError);
  return { kind, path };
};

if (import.meta.main) {
  await generateReleaseProvenance(parseCliArgs(process.argv.slice(2)));
}
