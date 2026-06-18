#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import { $ } from "bun";

import {
  type DeprecationReleaseOffender,
  type DeprecationReleaseResult,
  checkDeprecationReleaseGate,
} from "./check-deprecations.ts";
import { CI_PLATFORMS, type CiPlatform } from "./ci-platforms.ts";
import { prepareNpmAlphaPackages, releasePackageNames } from "./prepare-npm-dev-packages.ts";
import { releaseProvenancePathForArtifact } from "./release-provenance.ts";

export type ArtifactTarget = "all" | "binary" | "library";
export type ReleaseArtifactFamily = "binary" | "library" | "binary+library";
export type ReleaseRunnerKind = "spawn" | "shell" | "skip";
export type ReleaseEnvironment = Record<string, string | undefined>;

export interface ReleaseCommand {
  readonly stageId: string;
  readonly artifactFamily: ReleaseArtifactFamily;
  readonly summary: string;
  readonly remediation: string;
}

export interface ReleaseSpawnCommand extends ReleaseCommand {
  readonly cmd: ReadonlyArray<string>;
}

export interface ReleaseShellCommand extends ReleaseCommand {
  readonly script: string;
  readonly prepareNpmAlphaPackages?: boolean;
}

export interface ReleaseRunner {
  readonly spawn: (command: ReleaseSpawnCommand) => Promise<void>;
  readonly shell: (command: ReleaseShellCommand) => Promise<void>;
}

export interface ReleaseStage {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly forBinary: boolean;
  readonly forLibrary: boolean;
  readonly kind: ReleaseRunnerKind;
  readonly commandSummary: string;
  readonly remediation: string;
  readonly run: (context: ReleaseStageContext) => Promise<void>;
}

export interface ReleaseStageContext {
  readonly target: ArtifactTarget;
  readonly env: ReleaseEnvironment;
  readonly localRehearsal: boolean;
  readonly runner: ReleaseRunner;
  readonly logger: (line: string) => void;
  readonly now: () => number;
}

export type DeprecationGate = (input: {
  readonly env: ReleaseEnvironment;
  readonly target: ArtifactTarget;
}) => Promise<DeprecationReleaseResult>;

interface ReleaseOptions {
  readonly target?: ArtifactTarget;
  readonly throughStage?: number | string;
  readonly env?: ReleaseEnvironment;
  readonly runner?: ReleaseRunner;
  readonly logger?: (line: string) => void;
  readonly deprecationGate?: DeprecationGate;
  readonly now?: () => number;
}

interface ReleaseCliOptions {
  readonly target: ArtifactTarget;
  readonly throughStage?: number | string;
}

export class ReleaseStageError extends Error {
  readonly _tag = "ReleaseStageError";

  constructor(
    readonly stageId: string,
    readonly artifactFamily: ReleaseArtifactFamily,
    readonly commandSummary: string,
    readonly remediation: string,
    override readonly cause: unknown,
  ) {
    super(`Release stage ${stageId} failed for ${artifactFamily}: ${commandSummary}`);
    this.name = "ReleaseStageError";
  }
}

export class ReleaseCompileBudgetError extends Error {
  readonly _tag = "ReleaseCompileBudgetError";

  constructor(
    readonly platformId: string,
    readonly durationMs: number,
    readonly budgetMs: number,
  ) {
    super(`Release compile for ${platformId} took ${durationMs}ms, exceeding the ${budgetMs}ms budget.`);
    this.name = "ReleaseCompileBudgetError";
  }
}

const resolveReleasePlatform = (platformId: string): CiPlatform => {
  const platform = CI_PLATFORMS.find((candidate) => candidate.id === platformId);
  if (platform === undefined) throw new Error(`Unknown release platform: ${platformId}`);
  return platform;
};

const hostReleasePlatform = (): CiPlatform => {
  const platformId = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  return resolveReleasePlatform(platformId);
};

const releasePlatformsForContext = (context: ReleaseStageContext): ReadonlyArray<CiPlatform> => {
  const platformId = envValue(context.env, "LANDO_RELEASE_PLATFORM");
  if (platformId !== undefined) return [resolveReleasePlatform(platformId)];
  if (context.localRehearsal) return [hostReleasePlatform()];
  return CI_PLATFORMS;
};

const hasMacosPlatform = (platforms: ReadonlyArray<CiPlatform>): boolean =>
  platforms.some((platform) => platform.id.startsWith("darwin-"));

const hasWindowsPlatform = (platforms: ReadonlyArray<CiPlatform>): boolean =>
  platforms.some((platform) => platform.id === "windows-x64");

const targetFlags = {
  "--all": "all",
  "--binary": "binary",
  "--binary-only": "binary",
  "--library": "library",
  "--library-only": "library",
} satisfies Record<string, ArtifactTarget>;

const isTargetFlag = (arg: string): arg is keyof typeof targetFlags => arg in targetFlags;

export const parseReleaseOptions = (args: ReadonlyArray<string>): ReleaseCliOptions => {
  let target: ArtifactTarget | undefined;
  let throughStage: number | string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;

    if (arg.startsWith("--through-stage=")) {
      throughStage = arg.slice("--through-stage=".length);
      continue;
    }

    if (arg === "--through-stage") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error("--through-stage expects a stage id or number");
      throughStage = value;
      index += 1;
      continue;
    }

    if (!isTargetFlag(arg)) {
      throw new Error(`Unknown release argument: ${arg}`);
    }

    const nextTarget = targetFlags[arg];
    if (target !== undefined && target !== nextTarget) {
      throw new Error(`Conflicting release targets: ${target} and ${nextTarget}`);
    }
    target = nextTarget;
  }

  return { target: target ?? "all", throughStage };
};

const stageMatchesTarget = (stage: ReleaseStage, target: ArtifactTarget): boolean => {
  if (target === "all") return true;
  if (target === "binary") return stage.forBinary;
  return stage.forLibrary;
};

const artifactFamilyForStage = (
  stage: Pick<ReleaseStage, "forBinary" | "forLibrary">,
  target: ArtifactTarget,
): ReleaseArtifactFamily => {
  if (target === "binary" || target === "library") return target;
  if (stage.forBinary && stage.forLibrary) return "binary+library";
  if (stage.forBinary) return "binary";
  return "library";
};

const stagePrefixLimit = (throughStage: number | string | undefined): ReadonlyArray<ReleaseStage> => {
  if (throughStage === undefined) return RELEASE_STAGES;
  const value = String(throughStage);
  const stageIndex = RELEASE_STAGES.findIndex(
    (stage) => stage.id === value || stage.id.startsWith(`${value}-`),
  );
  if (stageIndex === -1) throw new Error(`Unknown release stage prefix: ${value}`);
  return RELEASE_STAGES.slice(0, stageIndex + 1);
};

interface CredentialRequirement {
  readonly allOf?: ReadonlyArray<string>;
  readonly allOfAny?: ReadonlyArray<ReadonlyArray<string>>;
  readonly anyOf?: ReadonlyArray<ReadonlyArray<string>>;
}

const envHas = (env: ReleaseEnvironment, name: string): boolean =>
  env[name] !== undefined && env[name] !== "";

const hasRequiredCredentials = (env: ReleaseEnvironment, requirement: CredentialRequirement): boolean => {
  const required = requirement.allOf ?? [];
  if (!required.every((name) => envHas(env, name))) return false;

  const requiredAlternatives = requirement.allOfAny ?? [];
  if (!requiredAlternatives.every((group) => group.some((name) => envHas(env, name)))) return false;

  const alternatives = requirement.anyOf ?? [];
  if (alternatives.length > 0 && !alternatives.some((group) => group.some((name) => envHas(env, name))))
    return false;

  return true;
};

const credentialGate = (
  stageId: string,
  credentialLabel: string,
  requirement: CredentialRequirement,
  { env, localRehearsal, logger }: ReleaseStageContext,
): boolean => {
  if (hasRequiredCredentials(env, requirement)) return true;
  if (localRehearsal) {
    logger(`[release] warning LOCAL_REHEARSAL=1: skip ${stageId} (${credentialLabel} absent)`);
    return false;
  }
  throw new Error(`Missing ${credentialLabel}; set LOCAL_REHEARSAL=1 to rehearse without credentials.`);
};

const npmAlphaPublishScript = (): string =>
  [
    'before_latest="$(npm view @lando/core dist-tags.latest --json 2>/dev/null || true)"',
    ...releasePackageNames.map(
      (packageName) => `npm publish --workspace ${packageName} --access public --tag dev --provenance`,
    ),
    'after_latest="$(npm view @lando/core dist-tags.latest --json 2>/dev/null || true)"',
    'test "$before_latest" = "$after_latest"',
    "npm view @lando/core dist-tags.dev --json | grep -Eq '\"?4\\.0\\.0-alpha\\.[0-9]+\"?'",
  ].join("\n");

const libraryBundleCommands = (): ReadonlyArray<ReadonlyArray<string>> =>
  releasePackageNames.map((packageName) => ["bun", "run", `--filter=${packageName}`, "build"]);

const defaultRemediation = "Fix the failed release stage and rerun scripts/release.ts from a clean tree.";
const compileBudgetMs = 10 * 60 * 1000;

const macosSigningCredentials: CredentialRequirement = {
  allOf: ["LANDO_RELEASE_SIGNING_IDENTITY"],
};
const windowsSigningCredentials: CredentialRequirement = {
  allOf: [
    "LANDO_RELEASE_WINDOWS_CERTIFICATE",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ],
};
const appleNotarizationCredentials: CredentialRequirement = {
  allOf: ["LANDO_RELEASE_APPLE_KEYCHAIN_PROFILE"],
};
const manifestChecksumSigningCredentials: CredentialRequirement = {
  allOfAny: [["LANDO_RELEASE_GPG_KEY", "GPG_PRIVATE_KEY"]],
};
const manifestCosignCredentials: CredentialRequirement = {
  allOf: ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"],
};
const provenanceCredentials: CredentialRequirement = {
  allOf: ["ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"],
};
const libraryPublishCredentials: CredentialRequirement = {
  anyOf: [["LANDO_RELEASE_NPM_TOKEN", "NPM_TOKEN"]],
};
const githubReleaseCredentials: CredentialRequirement = {
  anyOf: [["GH_TOKEN", "GITHUB_TOKEN"]],
};

const credentialSkipRequirements: Record<
  string,
  { readonly label: string; readonly credentials: CredentialRequirement }
> = {
  "10-notarize": { label: "Apple notarization credentials", credentials: appleNotarizationCredentials },
  "12-provenance-sbom": { label: "provenance and cosign credentials", credentials: provenanceCredentials },
};

const macosReleaseArtifactPaths = (platforms: ReadonlyArray<CiPlatform>): ReadonlyArray<string> =>
  platforms
    .filter((platform) => platform.id.startsWith("darwin-"))
    .sort((left, right) => (left.id === "darwin-x64" ? -1 : right.id === "darwin-x64" ? 1 : 0))
    .map(releaseBinaryPath);

const checksumManifestArtifactPaths = (platforms: ReadonlyArray<CiPlatform>): ReadonlyArray<string> =>
  [...platforms].sort((left, right) => left.id.localeCompare(right.id)).map(releaseBinaryPath);

const macosCodesignCommands = (
  env: ReleaseEnvironment,
  platforms: ReadonlyArray<CiPlatform>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const identity = env.LANDO_RELEASE_SIGNING_IDENTITY;
  if (identity === undefined || identity === "")
    throw new Error("Missing macOS Developer ID signing identity");
  return macosReleaseArtifactPaths(platforms).map((artifactPath) => [
    "codesign",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--timestamp",
    "--entitlements",
    "scripts/lando.entitlements",
    artifactPath,
  ]);
};

const macosNotaryAuthArgs = (env: ReleaseEnvironment): ReadonlyArray<string> => {
  const keychainProfile = env.LANDO_RELEASE_APPLE_KEYCHAIN_PROFILE;
  if (keychainProfile !== undefined && keychainProfile !== "") return ["--keychain-profile", keychainProfile];
  throw new Error("Missing Apple notarization credentials");
};

const macosNotarizationCommands = (
  env: ReleaseEnvironment,
  platforms: ReadonlyArray<CiPlatform>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const authArgs = macosNotaryAuthArgs(env);
  return macosReleaseArtifactPaths(platforms).flatMap((artifactPath) => [
    ["xcrun", "notarytool", "submit", artifactPath, ...authArgs, "--wait"],
    ["xcrun", "stapler", "staple", artifactPath],
    ["xcrun", "stapler", "validate", artifactPath],
  ]);
};

const DEFAULT_WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com";
const DEFAULT_COSIGN_CERTIFICATE_IDENTITY_REGEXP =
  "^https://github.com/lando-community/core4/.github/workflows/release.yml@refs/tags/.+$";
const COSIGN_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

const envValue = (env: ReleaseEnvironment, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

const requiredEnv = (env: ReleaseEnvironment, name: string): string => {
  const value = envValue(env, name);
  if (value === undefined) throw new Error(`Missing ${name} for Windows release signing.`);
  return value;
};

const cosignCertificateIdentityRegexp = (env: ReleaseEnvironment): string =>
  envValue(env, "LANDO_RELEASE_COSIGN_CERTIFICATE_IDENTITY_REGEXP") ??
  DEFAULT_COSIGN_CERTIFICATE_IDENTITY_REGEXP;

const spawnCommands = async (
  runner: ReleaseRunner,
  command: Omit<ReleaseSpawnCommand, "cmd">,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): Promise<void> => {
  for (const cmd of commands) {
    await runner.spawn({ ...command, cmd });
  }
};

const spawnCommandsForStage = (
  stageId: string,
  context: ReleaseStageContext,
  platforms: ReadonlyArray<CiPlatform>,
  commands: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  if (stageId === "10-notarize") return macosNotarizationCommands(context.env, platforms);
  return commands;
};

const updateManifestScriptPath = new URL("./build-update-manifest.ts", import.meta.url).pathname;

const releaseUpdateManifestScript = (
  platforms: ReadonlyArray<CiPlatform>,
  env: ReleaseEnvironment,
  options: { readonly allowMissingBinaries?: boolean } = {},
): string => {
  const args = [
    "bun",
    updateManifestScriptPath,
    "--version",
    releaseVersion(env),
    "--dist-dir",
    "dist",
    "--output",
    "dist/update-manifest.json",
  ];
  const minimum = envValue(env, "LANDO_RELEASE_UPDATE_MINIMUM");
  if (minimum !== undefined) args.push("--minimum", minimum);
  const released = envValue(env, "LANDO_RELEASE_RELEASED");
  if (released !== undefined) args.push("--released", released);
  const repository = envValue(env, "GITHUB_REPOSITORY");
  if (repository !== undefined) args.push("--repository", repository);
  const allowMissingBinaries =
    options.allowMissingBinaries ??
    (envValue(env, "LOCAL_REHEARSAL") === "1" ||
      platforms.length === 0 ||
      envValue(env, "LANDO_RELEASE_PLATFORM") !== undefined);
  if (allowMissingBinaries) {
    args.push("--allow-missing-binaries");
  }
  return args.map(shellQuote).join(" ");
};

const updateManifestPlatformsForContext = (context: ReleaseStageContext): ReadonlyArray<CiPlatform> =>
  context.target === "library" ? [] : releasePlatformsForContext(context);

const shouldSignUpdateManifest = (platforms: ReadonlyArray<CiPlatform>): boolean => platforms.length > 0;

const nonSigningManifestScript = (
  platforms: ReadonlyArray<CiPlatform>,
  env: ReleaseEnvironment = process.env,
): string => {
  const checksumArtifacts = checksumManifestArtifactPaths(platforms);
  return [
    "mkdir -p dist",
    ...checksumArtifacts.map((artifactPath) => `test -f "${artifactPath}"`),
    ": > dist/SHA256SUMS",
    ...checksumArtifacts.map((artifactPath) => `sha256sum "${artifactPath}" >> dist/SHA256SUMS`),
    ": > dist/SHA512SUMS",
    ...checksumArtifacts.map((artifactPath) => `sha512sum "${artifactPath}" >> dist/SHA512SUMS`),
    ...(shouldSignUpdateManifest(platforms) ? [releaseUpdateManifestScript(platforms, env)] : []),
  ].join("\n");
};

const CHECKSUM_SIGNATURE = "dist/SHA256SUMS.sig";
const CHECKSUM_CERTIFICATE = "dist/SHA256SUMS.crt";
const UPDATE_MANIFEST_SIGNATURE = "dist/update-manifest.json.sig";
const UPDATE_MANIFEST_CERTIFICATE = "dist/update-manifest.json.crt";
const releaseSbomScriptPath = new URL("./release-sbom.ts", import.meta.url).pathname;
const releaseProvenanceScriptPath = new URL("./release-provenance.ts", import.meta.url).pathname;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const markdownCommandQuote = (value: string): string => JSON.stringify(value);

const cosignSignAndVerifyBlobCommands = (
  env: ReleaseEnvironment,
  blobPath: string,
  signaturePath: string,
  certificatePath: string,
): ReadonlyArray<ReadonlyArray<string>> => {
  const certificateIdentityRegexp = cosignCertificateIdentityRegexp(env);

  return [
    [
      "cosign",
      "sign-blob",
      "--yes",
      "--output-signature",
      signaturePath,
      "--output-certificate",
      certificatePath,
      blobPath,
    ],
    [
      "cosign",
      "verify-blob",
      "--certificate-identity-regexp",
      certificateIdentityRegexp,
      "--certificate-oidc-issuer",
      COSIGN_OIDC_ISSUER,
      "--signature",
      signaturePath,
      "--certificate",
      certificatePath,
      blobPath,
    ],
  ];
};

const checksumCosignCommands = (env: ReleaseEnvironment): ReadonlyArray<ReadonlyArray<string>> =>
  cosignSignAndVerifyBlobCommands(env, "dist/SHA256SUMS", CHECKSUM_SIGNATURE, CHECKSUM_CERTIFICATE);

const updateManifestCosignCommands = (env: ReleaseEnvironment): ReadonlyArray<ReadonlyArray<string>> =>
  cosignSignAndVerifyBlobCommands(
    env,
    "dist/update-manifest.json",
    UPDATE_MANIFEST_SIGNATURE,
    UPDATE_MANIFEST_CERTIFICATE,
  );

const renderShellCommand = (cmd: ReadonlyArray<string>): string => cmd.map(shellQuote).join(" ");

const manifestSigningScript = (env: ReleaseEnvironment, platforms: ReadonlyArray<CiPlatform>): string =>
  [
    "gpg --batch --yes --armor --detach-sign dist/SHA256SUMS",
    "gpg --batch --yes --armor --detach-sign dist/SHA512SUMS",
    "gpg --batch --verify dist/SHA256SUMS.asc dist/SHA256SUMS",
    "gpg --batch --verify dist/SHA512SUMS.asc dist/SHA512SUMS",
    ...(shouldSignUpdateManifest(platforms)
      ? [
          releaseUpdateManifestScript(platforms, env, { allowMissingBinaries: false }),
          ...updateManifestCosignCommands(env).map(renderShellCommand),
        ]
      : []),
  ].join("\n");

const releaseBinaryPath = (platform: Pick<CiPlatform, "id">): string =>
  `./dist/lando-${platform.id}${platform.id === "windows-x64" ? ".exe" : ""}`;

interface ReleaseBinarySignatureArtifact {
  readonly binaryPath: string;
  readonly signaturePath: string;
  readonly certificatePath: string;
}

interface ReleaseInstallerArtifact {
  readonly sourcePath: string;
  readonly publishedPath: string;
  readonly stableUrl: string;
}

interface ReleaseTrustRootArtifact {
  readonly sourcePath: string;
  readonly publishedPath: string;
}

const normalizeReleaseArtifactPath = (path: string): string => path.replace(/^\.\//, "");

const releaseBinarySignatureArtifact = (path: string): ReleaseBinarySignatureArtifact => {
  const binaryPath = normalizeReleaseArtifactPath(path);
  return { binaryPath, signaturePath: `${binaryPath}.sig`, certificatePath: `${binaryPath}.crt` };
};

const releaseBinarySignatureArtifacts = (
  context: ReleaseStageContext,
): ReadonlyArray<ReleaseBinarySignatureArtifact> => {
  if (context.target === "library") return [];
  return releasePlatformsForContext(context).map((platform) =>
    releaseBinarySignatureArtifact(releaseBinaryPath(platform)),
  );
};

const installerArtifacts: ReadonlyArray<ReleaseInstallerArtifact> = [
  {
    sourcePath: "scripts/install.sh",
    publishedPath: "dist/install.sh",
    stableUrl: "https://get.lando.dev/install.sh",
  },
  {
    sourcePath: "scripts/install.ps1",
    publishedPath: "dist/install.ps1",
    stableUrl: "https://get.lando.dev/install.ps1",
  },
];

const installerTrustRootArtifacts: ReadonlyArray<ReleaseTrustRootArtifact> = [
  { sourcePath: "scripts/install/trust/lando-release-gpg.asc", publishedPath: "dist/lando-release-gpg.asc" },
  {
    sourcePath: "scripts/install/trust/lando-release-cosign.pub",
    publishedPath: "dist/lando-release-cosign.pub",
  },
];

const releaseInstallerSignatureArtifacts = (): ReadonlyArray<ReleaseBinarySignatureArtifact> =>
  installerArtifacts.map((artifact) => releaseBinarySignatureArtifact(artifact.publishedPath));

const installerArtifactStagingScript = (): string =>
  [
    "mkdir -p dist",
    ...installerArtifacts.flatMap((artifact) => [
      `test -f ${shellQuote(artifact.sourcePath)}`,
      `cp ${shellQuote(artifact.sourcePath)} ${shellQuote(artifact.publishedPath)}`,
    ]),
    ...installerTrustRootArtifacts.flatMap((artifact) => [
      `test -f ${shellQuote(artifact.sourcePath)}`,
      `cp ${shellQuote(artifact.sourcePath)} ${shellQuote(artifact.publishedPath)}`,
    ]),
  ].join("\n");

const binaryCosignCommands = (
  env: ReleaseEnvironment,
  artifacts: ReadonlyArray<ReleaseBinarySignatureArtifact>,
): ReadonlyArray<ReadonlyArray<string>> =>
  artifacts.flatMap((artifact) =>
    cosignSignAndVerifyBlobCommands(
      env,
      artifact.binaryPath,
      artifact.signaturePath,
      artifact.certificatePath,
    ),
  );

const renderBinaryVerificationCommand = (
  env: ReleaseEnvironment,
  artifact: ReleaseBinarySignatureArtifact,
): string =>
  [
    "cosign verify-blob \\",
    `  --certificate-identity-regexp ${markdownCommandQuote(cosignCertificateIdentityRegexp(env))} \\`,
    `  --certificate-oidc-issuer ${markdownCommandQuote(COSIGN_OIDC_ISSUER)} \\`,
    `  --signature ${artifact.signaturePath} \\`,
    `  --certificate ${artifact.certificatePath} \\`,
    `  ${artifact.binaryPath}`,
  ].join("\n");

const renderInstallerVerificationCommand = (
  env: ReleaseEnvironment,
  artifact: ReleaseInstallerArtifact,
): string => {
  const fileName = artifact.publishedPath.split("/").at(-1) ?? artifact.publishedPath;
  return [
    `curl -fsSLO ${markdownCommandQuote(artifact.stableUrl)}`,
    `curl -fsSLO ${markdownCommandQuote(`${artifact.stableUrl}.sig`)}`,
    `curl -fsSLO ${markdownCommandQuote(`${artifact.stableUrl}.crt`)}`,
    "cosign verify-blob \\",
    `  --certificate-identity-regexp ${markdownCommandQuote(cosignCertificateIdentityRegexp(env))} \\`,
    `  --certificate-oidc-issuer ${markdownCommandQuote(COSIGN_OIDC_ISSUER)} \\`,
    `  --signature ${fileName}.sig \\`,
    `  --certificate ${fileName}.crt \\`,
    `  ${fileName}`,
  ].join("\n");
};

const releaseBinaryVerificationNotes = (
  env: ReleaseEnvironment,
  artifacts: ReadonlyArray<ReleaseBinarySignatureArtifact>,
): string =>
  [
    "## Binary Verification",
    "",
    "Each release binary is keyless-signed with cosign through GitHub Actions OIDC.",
    "",
    ...artifacts.flatMap((artifact) => [
      `### ${artifact.binaryPath.split("/").at(-1)}`,
      "",
      `Signature: \`${artifact.signaturePath}\``,
      `Certificate: \`${artifact.certificatePath}\``,
      "",
      "```bash",
      renderBinaryVerificationCommand(env, artifact),
      "```",
      "",
    ]),
    "## Installer Script Verification",
    "",
    "The curl-pipe installer scripts are keyless-signed with detached signatures at the stable get.lando.dev URLs.",
    "",
    ...installerArtifacts.flatMap((artifact) => [
      `### ${artifact.publishedPath.split("/").at(-1)}`,
      "",
      `Stable URL: \`${artifact.stableUrl}\``,
      `Signature: \`${artifact.stableUrl}.sig\``,
      `Certificate: \`${artifact.stableUrl}.crt\``,
      "",
      "```bash",
      renderInstallerVerificationCommand(env, artifact),
      "```",
      "",
    ]),
  ].join("\n");

const releaseBinaryVerificationNotesScript = (
  env: ReleaseEnvironment,
  artifacts: ReadonlyArray<ReleaseBinarySignatureArtifact>,
): string =>
  [
    "mkdir -p dist",
    "cat > dist/release-notes.md <<'LANDO_RELEASE_NOTES'",
    releaseBinaryVerificationNotes(env, artifacts),
    "LANDO_RELEASE_NOTES",
  ].join("\n");

const releaseVersion = (env: ReleaseEnvironment): string => envValue(env, "LANDO_RELEASE_VERSION") ?? "0.0.0";

const releaseLibraryArchivePath = (version: string): string => `./dist/lando-library-${version}.tgz`;

type ReleaseManifestArtifactKind = "binary" | "library";

interface ReleaseManifestFileEntry {
  readonly path: string;
  readonly sha256: string;
}

interface ReleaseManifestArtifactEntry {
  readonly kind: ReleaseManifestArtifactKind;
  readonly path: string;
  readonly sha256: string;
  readonly sbom?: ReleaseManifestFileEntry;
  readonly provenance?: ReleaseManifestFileEntry;
}

interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly artifacts: Record<string, ReleaseManifestArtifactEntry>;
}

const assertObjectRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const releaseManifestFileEntry = (value: unknown, label: string): ReleaseManifestFileEntry | undefined => {
  if (value === undefined) return undefined;
  const entry = assertObjectRecord(value, label);
  const path = entry.path;
  const sha256 = entry.sha256;
  if (typeof path !== "string" || path === "" || typeof sha256 !== "string" || sha256 === "") {
    throw new Error(`${label} is not a release manifest file entry`);
  }
  return { path, sha256 };
};

const readReleaseManifest = async (
  manifestPath = "dist/release-artifacts.json",
): Promise<ReleaseManifest> => {
  const root = assertObjectRecord(JSON.parse(await readFile(manifestPath, "utf8")), "release manifest");
  const artifactsValue = root.artifacts;
  const artifactRecords = artifactsValue === undefined ? {} : assertObjectRecord(artifactsValue, "artifacts");
  const artifacts: Record<string, ReleaseManifestArtifactEntry> = {};

  for (const [name, value] of Object.entries(artifactRecords)) {
    const entry = assertObjectRecord(value, `artifact ${name}`);
    const kind = entry.kind;
    const path = entry.path;
    const sha256 = entry.sha256;
    if ((kind !== "binary" && kind !== "library") || typeof path !== "string" || typeof sha256 !== "string") {
      throw new Error(`artifact ${name} is not a release manifest artifact entry`);
    }
    const sbom = releaseManifestFileEntry(entry.sbom, `artifact ${name} sbom`);
    const provenance = releaseManifestFileEntry(entry.provenance, `artifact ${name} provenance`);
    artifacts[name] = {
      kind,
      path,
      sha256,
      ...(sbom === undefined ? {} : { sbom }),
      ...(provenance === undefined ? {} : { provenance }),
    };
  }

  return { schemaVersion: 1, artifacts };
};

const releaseManifestEntryForPath = (
  manifest: ReleaseManifest,
  path: string,
): readonly [string, ReleaseManifestArtifactEntry] | undefined => {
  const normalizedPath = normalizeReleaseArtifactPath(path);
  return Object.entries(manifest.artifacts).find(([, entry]) => entry.path === normalizedPath);
};

const requireReleaseManifestArtifact = (
  manifest: ReleaseManifest,
  path: string,
  kind: ReleaseManifestArtifactKind,
): readonly [string, ReleaseManifestArtifactEntry] => {
  const normalizedPath = normalizeReleaseArtifactPath(path);
  const match = releaseManifestEntryForPath(manifest, path);
  if (match === undefined)
    throw new Error(`Release manifest missing required ${kind} artifact: ${normalizedPath}`);
  const [name, entry] = match;
  if (entry.kind !== kind) {
    throw new Error(`Release manifest artifact ${name} has kind ${entry.kind}, expected ${kind}`);
  }
  return match;
};

const requireReleaseManifestLinkedFile = (
  name: string,
  entry: ReleaseManifestArtifactEntry,
  field: "sbom" | "provenance",
): ReleaseManifestFileEntry => {
  const linked = entry[field];
  if (linked !== undefined) return linked;
  const label = field === "sbom" ? "SBOM" : "SLSA provenance attestation";
  throw new Error(`Release manifest artifact ${name} lacks a matching ${label}`);
};

const uniqueAssetPaths = (assets: ReadonlyArray<string>): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const unique: Array<string> = [];
  for (const asset of assets) {
    const normalized = normalizeReleaseArtifactPath(asset);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
};

const releaseGitHubAssetPaths = async (context: ReleaseStageContext): Promise<ReadonlyArray<string>> => {
  const version = releaseVersion(context.env);
  const manifest = await readReleaseManifest();
  const assets: Array<string> = [];

  if (context.target !== "library") {
    for (const platform of releasePlatformsForContext(context)) {
      const [name, entry] = requireReleaseManifestArtifact(manifest, releaseBinaryPath(platform), "binary");
      const sbom = requireReleaseManifestLinkedFile(name, entry, "sbom");
      const provenance = requireReleaseManifestLinkedFile(name, entry, "provenance");
      assets.push(entry.path, `${entry.path}.sig`, `${entry.path}.crt`, sbom.path, provenance.path);
      assets.push(`${provenance.path}.sig`, `${provenance.path}.crt`);
    }
  }

  if (context.target !== "binary") {
    const [name, entry] = requireReleaseManifestArtifact(
      manifest,
      releaseLibraryArchivePath(version),
      "library",
    );
    const sbom = requireReleaseManifestLinkedFile(name, entry, "sbom");
    const provenance = requireReleaseManifestLinkedFile(name, entry, "provenance");
    assets.push(entry.path, sbom.path, provenance.path, `${provenance.path}.sig`, `${provenance.path}.crt`);
  }

  assets.push(
    "dist/SHA256SUMS",
    "dist/SHA256SUMS.asc",
    "dist/SHA256SUMS.sig",
    "dist/SHA256SUMS.crt",
    "dist/SHA512SUMS",
    "dist/SHA512SUMS.asc",
    "dist/release-artifacts.json",
  );
  if (context.target !== "library") {
    assets.push(
      "dist/update-manifest.json",
      "dist/update-manifest.json.sig",
      "dist/update-manifest.json.crt",
      "dist/release-notes.md",
    );
  }

  return uniqueAssetPaths(assets);
};

const releaseTag = (env: ReleaseEnvironment): string =>
  envValue(env, "LANDO_RELEASE_TAG") ?? `v${releaseVersion(env)}`;

const releaseTitle = (env: ReleaseEnvironment): string =>
  envValue(env, "LANDO_RELEASE_TITLE") ?? `Lando ${releaseVersion(env)}`;

const githubReleaseScript = (env: ReleaseEnvironment, assets: ReadonlyArray<string>): string => {
  const version = releaseVersion(env);
  const targetSha = envValue(env, "GITHUB_SHA");
  const createArgs = [
    "gh",
    "release",
    "create",
    releaseTag(env),
    ...assets,
    "--title",
    releaseTitle(env),
    ...(version.includes("-") ? ["--prerelease"] : []),
    ...(assets.includes("dist/release-notes.md") ? ["--notes-file", "dist/release-notes.md"] : []),
    ...(targetSha === undefined ? [] : ["--target", targetSha]),
  ];
  return [
    ...assets.map((asset) => `test -f ${shellQuote(asset)}`),
    createArgs.map(shellQuote).join(" "),
  ].join("\n");
};

const releaseSbomArtifacts = (context: ReleaseStageContext, version: string): ReadonlyArray<string> => {
  const artifacts: Array<string> = [];
  if (context.target !== "library") {
    artifacts.push(
      ...releasePlatformsForContext(context).map((platform) => `binary:${releaseBinaryPath(platform)}`),
      ...installerArtifacts.map((artifact) => `installer:${artifact.publishedPath}`),
      ...installerTrustRootArtifacts.map((artifact) => `trust-root:${artifact.publishedPath}`),
    );
  }
  if (context.target !== "binary") artifacts.push(`library:${releaseLibraryArchivePath(version)}`);
  return artifacts;
};

const releaseSbomScript = (context: ReleaseStageContext): string => {
  const version = releaseVersion(context.env);
  const args = [
    "bun",
    releaseSbomScriptPath,
    "--version",
    version,
    "--manifest",
    "dist/release-artifacts.json",
    ...releaseSbomArtifacts(context, version).flatMap((artifact) => ["--artifact", artifact]),
  ];
  return args.map(shellQuote).join(" ");
};

const releaseProvenanceScript = (context: ReleaseStageContext): string => {
  const version = releaseVersion(context.env);
  const args = [
    "bun",
    releaseProvenanceScriptPath,
    "--version",
    version,
    "--manifest",
    "dist/release-artifacts.json",
    "--source-ref",
    envValue(context.env, "GITHUB_REF") ?? "",
    "--commit-sha",
    envValue(context.env, "GITHUB_SHA") ?? "",
    "--repository",
    envValue(context.env, "GITHUB_REPOSITORY") ?? "lando-community/core4",
    "--workflow-ref",
    envValue(context.env, "GITHUB_WORKFLOW_REF") ??
      `lando-community/core4/.github/workflows/release.yml@${envValue(context.env, "GITHUB_REF") ?? ""}`,
    ...releaseSbomArtifacts(context, version).flatMap((artifact) => ["--artifact", artifact]),
  ];
  return args.map(shellQuote).join(" ");
};

const releaseProvenanceFiles = (context: ReleaseStageContext): ReadonlyArray<string> => {
  const version = releaseVersion(context.env);
  return releaseSbomArtifacts(context, version).map((artifact) => {
    const separator = artifact.indexOf(":");
    return releaseProvenancePathForArtifact(artifact.slice(separator + 1), version);
  });
};

const provenanceCosignCommands = (
  env: ReleaseEnvironment,
  files: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> =>
  files.flatMap((provenancePath) =>
    cosignSignAndVerifyBlobCommands(env, provenancePath, `${provenancePath}.sig`, `${provenancePath}.crt`),
  );

const windowsSigningCommands = (env: ReleaseEnvironment): ReadonlyArray<ReadonlyArray<string>> => {
  const certificate = requiredEnv(env, "LANDO_RELEASE_WINDOWS_CERTIFICATE");
  const certificatePassword = envValue(env, "LANDO_RELEASE_WINDOWS_CERTIFICATE_PASSWORD");
  const timestampUrl = envValue(env, "LANDO_RELEASE_WINDOWS_TIMESTAMP_URL") ?? DEFAULT_WINDOWS_TIMESTAMP_URL;
  const certificateIdentityRegexp = cosignCertificateIdentityRegexp(env);
  const binaryPath = releaseBinaryPath({ id: "windows-x64" });
  const signaturePath = `${binaryPath}.sig`;
  const certificatePath = `${binaryPath}.crt`;

  return [
    [
      "signtool",
      "sign",
      "/tr",
      timestampUrl,
      "/td",
      "sha256",
      "/fd",
      "sha256",
      "/f",
      certificate,
      ...(certificatePassword === undefined ? [] : ["/p", certificatePassword]),
      binaryPath,
    ],
    [
      "cosign",
      "sign-blob",
      "--yes",
      "--output-signature",
      signaturePath,
      "--output-certificate",
      certificatePath,
      binaryPath,
    ],
    ["signtool", "verify", "/pa", "/v", binaryPath],
    [
      "cosign",
      "verify-blob",
      "--certificate-identity-regexp",
      certificateIdentityRegexp,
      "--certificate-oidc-issuer",
      COSIGN_OIDC_ISSUER,
      "--signature",
      signaturePath,
      "--certificate",
      certificatePath,
      binaryPath,
    ],
  ];
};

const compileCommand = (platform: CiPlatform): ReadonlyArray<string> => [
  "bun",
  "build",
  "./core/bin/lando.ts",
  "--compile",
  "--bytecode",
  `--target=${platform.bunTarget}`,
  `--outfile=${releaseBinaryPath(platform)}`,
  "--sourcemap=external",
];

const sanitizeCommand = (platform: CiPlatform): ReadonlyArray<string> => [
  "bun",
  "run",
  "scripts/sanitize-compiled-binary.ts",
  releaseBinaryPath(platform),
];

const compileReleaseBinaries = async (context: ReleaseStageContext): Promise<void> => {
  const artifactFamily = artifactFamilyForStage({ forBinary: true, forLibrary: false }, context.target);

  for (const platform of releasePlatformsForContext(context)) {
    const startedAt = context.now();
    await context.runner.spawn({
      stageId: "7-compile",
      artifactFamily,
      summary: "bun build --compile --bytecode ./core/bin/lando.ts",
      remediation: defaultRemediation,
      cmd: compileCommand(platform),
    });
    const durationMs = context.now() - startedAt;
    context.logger(
      `[release] compile ${platform.id} completed in ${durationMs}ms (budget ${compileBudgetMs}ms)`,
    );
    if (platform.id === "linux-x64" && durationMs > compileBudgetMs) {
      throw new ReleaseCompileBudgetError(platform.id, durationMs, compileBudgetMs);
    }
    await context.runner.spawn({
      stageId: "7-compile",
      artifactFamily,
      summary: "sanitize compiled release binary",
      remediation: defaultRemediation,
      cmd: sanitizeCommand(platform),
    });
  }
};

const spawnStage =
  (
    stage: Pick<ReleaseStage, "id" | "forBinary" | "forLibrary" | "commandSummary" | "remediation">,
    commands: ReadonlyArray<ReadonlyArray<string>>,
  ) =>
  async (context: ReleaseStageContext): Promise<void> => {
    const { runner, target } = context;
    const requirement = credentialSkipRequirements[stage.id];
    const platforms = stage.id === "10-notarize" ? releasePlatformsForContext(context) : [];

    if (stage.id === "10-notarize" && !hasMacosPlatform(platforms)) {
      context.logger("[release] skip 10-notarize (no macOS release platform selected)");
      return;
    }

    if (
      requirement !== undefined &&
      !credentialGate(stage.id, requirement.label, requirement.credentials, context)
    )
      return;

    for (const cmd of spawnCommandsForStage(stage.id, context, platforms, commands)) {
      await runner.spawn({
        stageId: stage.id,
        artifactFamily: artifactFamilyForStage(stage, target),
        summary: stage.commandSummary,
        remediation: stage.remediation,
        cmd,
      });
    }
  };

const shellStage =
  (
    stage: Pick<ReleaseStage, "id" | "forBinary" | "forLibrary" | "commandSummary" | "remediation">,
    script: string,
  ) =>
  async (context: ReleaseStageContext): Promise<void> => {
    const { runner, target } = context;
    const artifactFamily = artifactFamilyForStage(stage, target);

    if (stage.id === "11-manifest") {
      const updateManifestPlatforms = updateManifestPlatformsForContext(context);
      await runner.shell({
        stageId: stage.id,
        artifactFamily,
        summary: stage.commandSummary,
        remediation: stage.remediation,
        script: nonSigningManifestScript(updateManifestPlatforms, context.env),
      });
      if (
        !credentialGate(
          "11-manifest signing",
          "checksum manifest signing credentials",
          manifestChecksumSigningCredentials,
          context,
        )
      ) {
        return;
      }
      if (
        shouldSignUpdateManifest(updateManifestPlatforms) &&
        !credentialGate(
          "11-manifest signing",
          "update manifest cosign credentials",
          manifestCosignCredentials,
          context,
        )
      ) {
        return;
      }
      await runner.shell({
        stageId: stage.id,
        artifactFamily,
        summary: "sign release checksum manifests",
        remediation: stage.remediation,
        script: manifestSigningScript(context.env, updateManifestPlatforms),
      });
      return;
    }

    if (stage.id === "13-publish") {
      if (
        target !== "binary" &&
        !credentialGate(stage.id, "publish credentials", libraryPublishCredentials, context)
      ) {
        return;
      }
      if (!credentialGate(stage.id, "GitHub Releases credentials", githubReleaseCredentials, context)) return;
      if (context.localRehearsal) {
        context.logger(
          "[release] warning LOCAL_REHEARSAL=1: skip 13-publish (local rehearsal never publishes)",
        );
        return;
      }

      await runner.shell({
        stageId: stage.id,
        artifactFamily,
        summary: "publish GitHub Releases assets",
        remediation: stage.remediation,
        script: githubReleaseScript(context.env, await releaseGitHubAssetPaths(context)),
      });

      if (target === "binary") {
        context.logger("[release] skip 13-publish npm packages (binary release target)");
        return;
      }
    }

    await runner.shell({
      stageId: stage.id,
      artifactFamily,
      summary: stage.commandSummary,
      remediation: stage.remediation,
      script,
      prepareNpmAlphaPackages: stage.id === "13-publish",
    });
  };

const skipStage =
  (stage: Pick<ReleaseStage, "id">, reason: string) =>
  async (context: ReleaseStageContext): Promise<void> => {
    const requirement = credentialSkipRequirements[stage.id];
    if (
      requirement !== undefined &&
      !credentialGate(stage.id, requirement.label, requirement.credentials, context)
    )
      return;
    if (requirement !== undefined && !context.localRehearsal) {
      throw new Error(`Release stage ${stage.id} is not implemented yet; local rehearsal may skip it.`);
    }
    const { logger } = context;
    logger(reason);
  };

const defineStage = (
  stage: Omit<ReleaseStage, "run"> & {
    readonly command: ReadonlyArray<string> | ReadonlyArray<ReadonlyArray<string>> | string;
  },
): ReleaseStage => {
  const base = {
    id: stage.id,
    forBinary: stage.forBinary,
    forLibrary: stage.forLibrary,
    commandSummary: stage.commandSummary,
    remediation: stage.remediation,
  };

  if (stage.kind === "spawn") {
    const commands = Array.isArray(stage.command[0])
      ? (stage.command as ReadonlyArray<ReadonlyArray<string>>)
      : [stage.command as ReadonlyArray<string>];
    return { ...stage, run: spawnStage(base, commands) };
  }

  if (stage.kind === "shell") {
    return { ...stage, run: shellStage(base, stage.command as string) };
  }

  return { ...stage, run: skipStage(base, stage.command as string) };
};

interface PlatformSigningPlan {
  readonly selected: (platforms: ReadonlyArray<CiPlatform>) => boolean;
  readonly credentialLabel: string;
  readonly credentials: CredentialRequirement;
  readonly commands: (
    env: ReleaseEnvironment,
    platforms: ReadonlyArray<CiPlatform>,
  ) => ReadonlyArray<ReadonlyArray<string>>;
}

const platformSigningPlans: ReadonlyArray<PlatformSigningPlan> = [
  {
    selected: hasMacosPlatform,
    credentialLabel: "macOS Developer ID signing identity",
    credentials: macosSigningCredentials,
    commands: macosCodesignCommands,
  },
  {
    selected: hasWindowsPlatform,
    credentialLabel: "Windows signing credentials",
    credentials: windowsSigningCredentials,
    commands: (env) => windowsSigningCommands(env),
  },
];

const platformSignStage: ReleaseStage = {
  id: "9-sign",
  label: "Sign",
  description: "macOS codesign, Windows Authenticode/keyless cosign, and manifest-layer Linux signing.",
  forBinary: true,
  forLibrary: false,
  kind: "spawn",
  commandSummary: "sign release binaries",
  remediation: "Provision platform signing credentials or run a local rehearsal mode that may skip signing.",
  run: async (context): Promise<void> => {
    const platforms = releasePlatformsForContext(context);
    const selectedPlans = platformSigningPlans.filter((plan) => plan.selected(platforms));
    const command = {
      stageId: "9-sign",
      artifactFamily: artifactFamilyForStage(platformSignStage, context.target),
      summary: platformSignStage.commandSummary,
      remediation: platformSignStage.remediation,
    };

    if (selectedPlans.length === 0) {
      context.logger("[release] skip 9-sign (selected release platforms are signed at the manifest layer)");
      return;
    }

    const gatedPlans = selectedPlans.filter((plan) =>
      credentialGate("9-sign", plan.credentialLabel, plan.credentials, context),
    );

    for (const plan of gatedPlans) {
      await spawnCommands(context.runner, command, plan.commands(context.env, platforms));
    }
  },
};

const provenanceSbomStage: ReleaseStage = {
  id: "12-provenance-sbom",
  label: "Provenance & SBOM",
  description: "CycloneDX SBOM + SLSA provenance + cosign signatures.",
  forBinary: true,
  forLibrary: true,
  kind: "spawn",
  commandSummary: "generate provenance and SBOM artifacts",
  remediation: "Fix provenance/SBOM generation or signing and rerun scripts/release.ts from a clean tree.",
  run: async (context): Promise<void> => {
    if (
      !credentialGate(
        "12-provenance-sbom",
        "provenance and cosign credentials",
        provenanceCredentials,
        context,
      )
    )
      return;

    const artifactFamily = artifactFamilyForStage(provenanceSbomStage, context.target);
    const binarySignatureArtifacts = releaseBinarySignatureArtifacts(context);
    const installerSignatureArtifacts =
      context.target === "library" ? [] : releaseInstallerSignatureArtifacts();

    await spawnCommands(
      context.runner,
      {
        stageId: "12-provenance-sbom",
        artifactFamily,
        summary: "cosign-sign and verify release checksum manifest",
        remediation: provenanceSbomStage.remediation,
      },
      checksumCosignCommands(context.env),
    );
    if (binarySignatureArtifacts.length > 0) {
      await spawnCommands(
        context.runner,
        {
          stageId: "12-provenance-sbom",
          artifactFamily,
          summary: "cosign-sign and verify release binaries",
          remediation: provenanceSbomStage.remediation,
        },
        binaryCosignCommands(context.env, binarySignatureArtifacts),
      );
      await context.runner.shell({
        stageId: "12-provenance-sbom",
        artifactFamily,
        summary: "write release-note binary verification commands",
        remediation: provenanceSbomStage.remediation,
        script: releaseBinaryVerificationNotesScript(context.env, binarySignatureArtifacts),
      });
    }
    if (installerSignatureArtifacts.length > 0) {
      await context.runner.shell({
        stageId: "12-provenance-sbom",
        artifactFamily,
        summary: "stage installer scripts and trust roots",
        remediation: provenanceSbomStage.remediation,
        script: installerArtifactStagingScript(),
      });
      await spawnCommands(
        context.runner,
        {
          stageId: "12-provenance-sbom",
          artifactFamily,
          summary: "cosign-sign and verify installer scripts",
          remediation: provenanceSbomStage.remediation,
        },
        binaryCosignCommands(context.env, installerSignatureArtifacts),
      );
    }
    await context.runner.shell({
      stageId: "12-provenance-sbom",
      artifactFamily,
      summary: "generate CycloneDX SBOM artifacts and link release artifact entries",
      remediation: provenanceSbomStage.remediation,
      script: releaseSbomScript(context),
    });
    context.logger("[release] generated CycloneDX SBOM artifacts");
    await context.runner.shell({
      stageId: "12-provenance-sbom",
      artifactFamily,
      summary: "generate SLSA provenance attestations and link release artifact entries",
      remediation: provenanceSbomStage.remediation,
      script: releaseProvenanceScript(context),
    });
    await spawnCommands(
      context.runner,
      {
        stageId: "12-provenance-sbom",
        artifactFamily,
        summary: "cosign-sign and verify SLSA provenance attestations",
        remediation: provenanceSbomStage.remediation,
      },
      provenanceCosignCommands(context.env, releaseProvenanceFiles(context)),
    );
    context.logger("[release] generated and signed SLSA provenance attestations");
  },
};

export const RELEASE_STAGES: ReadonlyArray<ReleaseStage> = [
  defineStage({
    id: "1-codegen",
    label: "Codegen",
    description: "Run scripts/codegen.ts to refresh every generated file.",
    forBinary: true,
    forLibrary: true,
    kind: "spawn",
    commandSummary: "bun run scripts/codegen.ts",
    remediation: defaultRemediation,
    command: ["bun", "run", "scripts/codegen.ts"],
  }),
  defineStage({
    id: "2-typecheck",
    label: "Type-check",
    description: "tsc -b across the workspace.",
    forBinary: true,
    forLibrary: true,
    kind: "spawn",
    commandSummary: "bun run typecheck",
    remediation: defaultRemediation,
    command: ["bun", "run", "typecheck"],
  }),
  defineStage({
    id: "3-lint-format",
    label: "Lint/format",
    description: "biome check (lint + format).",
    forBinary: true,
    forLibrary: true,
    kind: "spawn",
    commandSummary: "bun run lint",
    remediation: defaultRemediation,
    command: ["bun", "run", "lint"],
  }),
  defineStage({
    id: "4-test-gates",
    label: "Test gates",
    description: "bun --no-orphans test (unit + library + scenario + smoke).",
    forBinary: true,
    forLibrary: true,
    kind: "spawn",
    commandSummary: "bun --no-orphans test",
    remediation: defaultRemediation,
    command: ["bun", "--no-orphans", "test"],
  }),
  defineStage({
    id: "5-schema-artifacts",
    label: "Schema artifacts",
    description: "Generate dist/schemas/*.json + dist/types/*.d.ts.",
    forBinary: true,
    forLibrary: true,
    kind: "skip",
    commandSummary: "schema artifact generation",
    remediation: "Implement schema artifact generation before making this stage required.",
    command: "[release] skip 5-schema-artifacts (scripts/build-schema-json.ts not yet implemented)",
  }),
  defineStage({
    id: "6-library-bundle",
    label: "Library bundle",
    description: "bun build (no --compile) per package.json#exports entry.",
    forBinary: false,
    forLibrary: true,
    kind: "spawn",
    commandSummary: "bun run --filter=<release package> build",
    remediation: defaultRemediation,
    command: libraryBundleCommands(),
  }),
  {
    id: "7-compile",
    label: "Compile",
    description: "bun build --compile --bytecode --target=bun-${T} bin/lando.ts.",
    forBinary: true,
    forLibrary: false,
    kind: "spawn",
    commandSummary: "bun build --compile --bytecode ./core/bin/lando.ts",
    remediation: defaultRemediation,
    run: compileReleaseBinaries,
  },
  defineStage({
    id: "8-strip",
    label: "Strip",
    description: "Remove debug symbols where the platform supports it.",
    forBinary: true,
    forLibrary: false,
    kind: "skip",
    commandSummary: "strip release binaries",
    remediation: "Wire platform-specific strip commands before making this stage required.",
    command: "[release] skip 8-strip (platform-specific stripping not yet wired)",
  }),
  platformSignStage,
  defineStage({
    id: "10-notarize",
    label: "Notarize",
    description: "macOS only: notarytool submit + stapler staple.",
    forBinary: true,
    forLibrary: false,
    kind: "spawn",
    commandSummary: "notarize macOS release binaries",
    remediation:
      "Provision Apple notarization credentials or run a local rehearsal mode that may skip notarization.",
    command: [],
  }),
  defineStage({
    id: "11-manifest",
    label: "Manifest",
    description: "Write SHA256SUMS, SHA512SUMS, GPG-sign, write update-manifest.json.",
    forBinary: true,
    forLibrary: true,
    kind: "shell",
    commandSummary: "write release checksum and update manifests",
    remediation: "Implement release manifest generation before making this stage required.",
    command: nonSigningManifestScript(CI_PLATFORMS),
  }),
  provenanceSbomStage,
  defineStage({
    id: "13-publish",
    label: "Publish",
    description: "Publish @lando/core and bundled workspace packages to npm on the dev tag.",
    forBinary: true,
    forLibrary: true,
    kind: "shell",
    commandSummary: "prepare alpha packages and publish npm workspaces on the dev tag",
    remediation: defaultRemediation,
    command: npmAlphaPublishScript(),
  }),
];

const SECRET_ARGV_FLAGS: ReadonlySet<string> = new Set(["/p"]);

export const redactReleaseCommand = (cmd: ReadonlyArray<string>): string =>
  cmd.map((arg, index) => (index > 0 && SECRET_ARGV_FLAGS.has(cmd[index - 1]) ? "***" : arg)).join(" ");

const defaultRunner: ReleaseRunner = {
  spawn: async ({ cmd }) => {
    const proc = Bun.spawn([...cmd], { stdout: "inherit", stderr: "inherit" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Command exited ${exitCode}: ${redactReleaseCommand(cmd)}`);
  },
  shell: async ({ prepareNpmAlphaPackages: shouldPrepareNpmAlphaPackages = false, script }) => {
    if (shouldPrepareNpmAlphaPackages) await prepareNpmAlphaPackages();
    await $`sh -euc ${script}`;
  },
};

const defaultDeprecationGate: DeprecationGate = ({ env }) => checkDeprecationReleaseGate({ env });

const deprecationGateRemediation =
  "Remove every surface whose removeIn has arrived (or fix the flagged deprecation metadata) before releasing.";

const formatDeprecationOffender = (offender: DeprecationReleaseOffender): string => {
  const location = relative(process.cwd(), offender.file) || offender.file;
  const removeIn = offender.removeIn === undefined ? "" : ` removeIn=${offender.removeIn}`;
  const action = offender.expectedAction ?? offender.reason;
  return `  - ${offender.exportName} (${location}:${offender.line})${removeIn}: ${action}`;
};

const runDeprecationGate = async (
  gate: DeprecationGate,
  { env, target, logger }: ReleaseStageContext,
): Promise<void> => {
  const result = await gate({ env, target });
  if (result.ok) {
    logger("[release] deprecation gate passed (no surfaces past removeIn).");
    return;
  }
  const detail = result.offenders.map(formatDeprecationOffender).join("\n");
  throw new ReleaseStageError(
    "deprecation-gate",
    artifactFamilyForStage({ forBinary: true, forLibrary: true }, target),
    "bun run scripts/check-deprecations.ts",
    deprecationGateRemediation,
    new Error(
      `Deprecation gate blocked release; ${result.offenders.length} surface(s) must be removed or fixed:\n${detail}`,
    ),
  );
};

export const runRelease = async ({
  target = "all",
  throughStage,
  env = process.env,
  runner = defaultRunner,
  logger = console.log,
  deprecationGate = defaultDeprecationGate,
  now = () => Date.now(),
}: ReleaseOptions = {}): Promise<void> => {
  const stages = stagePrefixLimit(throughStage);
  const localRehearsal = env.LOCAL_REHEARSAL === "1";
  const matchingCount = stages.filter((stage) => stageMatchesTarget(stage, target)).length;
  logger(`[release] running ${matchingCount}/${RELEASE_STAGES.length} stages for ${target}`);

  for (const stage of stages) {
    if (!stageMatchesTarget(stage, target)) {
      logger(`[release] skip ${stage.id} (${target} release target)`);
      continue;
    }

    logger(`[release] -> ${stage.id}: ${stage.description}`);
    const context: ReleaseStageContext = { target, env, localRehearsal, runner, logger, now };
    try {
      await stage.run(context);
    } catch (cause) {
      throw new ReleaseStageError(
        stage.id,
        artifactFamilyForStage(stage, target),
        stage.commandSummary,
        stage.remediation,
        cause,
      );
    }

    if (stage.id === "1-codegen") {
      await runDeprecationGate(deprecationGate, context);
    }
  }

  logger("[release] done.");
};

const main = async (): Promise<void> => {
  await runRelease(parseReleaseOptions(process.argv.slice(2)));
};

if (import.meta.main) await main();
