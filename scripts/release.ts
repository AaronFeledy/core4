#!/usr/bin/env bun
/**
 * Lando v4 release orchestrator — runs the fixed release pipeline.
 *
 * The orchestrator owns stage ordering. Artifact families may skip stages, but
 * flags/config cannot reorder the canonical sequence.
 */
import { $ } from "bun";

import { prepareNpmAlphaPackages, releasePackageNames } from "./prepare-npm-dev-packages.ts";

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
}

interface ReleaseOptions {
  readonly target?: ArtifactTarget;
  readonly throughStage?: number | string;
  readonly env?: ReleaseEnvironment;
  readonly runner?: ReleaseRunner;
  readonly logger?: (line: string) => void;
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

export const parseReleaseTarget = (args: ReadonlyArray<string>): ArtifactTarget =>
  parseReleaseOptions(args).target;

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

const envHasAny = (env: ReleaseEnvironment, names: ReadonlyArray<string>): boolean =>
  names.some((name) => env[name] !== undefined && env[name] !== "");

const credentialGate = (
  stageId: string,
  credentialLabel: string,
  envNames: ReadonlyArray<string>,
  { env, localRehearsal, logger }: ReleaseStageContext,
): boolean => {
  if (envHasAny(env, envNames)) return true;
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

const releaseSigningCredentialEnv = [
  "LANDO_RELEASE_SIGNING_IDENTITY",
  "LANDO_RELEASE_WINDOWS_CERTIFICATE",
  "LANDO_RELEASE_COSIGN_KEY",
  "COSIGN_PRIVATE_KEY",
];
const appleNotarizationCredentialEnv = [
  "LANDO_RELEASE_APPLE_ID",
  "LANDO_RELEASE_APPLE_TEAM_ID",
  "LANDO_RELEASE_APPLE_KEYCHAIN_PROFILE",
  "APPLE_ID",
  "APPLE_TEAM_ID",
];
const manifestSigningCredentialEnv = ["LANDO_RELEASE_GPG_KEY", "LANDO_RELEASE_COSIGN_KEY", "GPG_PRIVATE_KEY"];
const provenanceCredentialEnv = [
  "LANDO_RELEASE_OIDC_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_TOKEN",
];
const publishCredentialEnv = [
  "LANDO_RELEASE_NPM_TOKEN",
  "NPM_TOKEN",
  "LANDO_RELEASE_GITHUB_TOKEN",
  "GITHUB_TOKEN",
];

const credentialSkipRequirements: Record<
  string,
  { readonly label: string; readonly envNames: ReadonlyArray<string> }
> = {
  "9-sign": { label: "release signing credentials", envNames: releaseSigningCredentialEnv },
  "10-notarize": { label: "Apple notarization credentials", envNames: appleNotarizationCredentialEnv },
  "12-provenance-sbom": { label: "provenance and cosign credentials", envNames: provenanceCredentialEnv },
};

const nonSigningManifestScript = (): string =>
  [
    "mkdir -p dist",
    ": > dist/SHA256SUMS",
    ": > dist/SHA512SUMS",
    "printf '%s\\n' '{\"schemaVersion\":1,\"artifacts\":{}}' > dist/update-manifest.json",
  ].join("\n");

const manifestSigningScript = (): string =>
  [
    "gpg --batch --yes --armor --detach-sign dist/SHA256SUMS",
    "gpg --batch --yes --armor --detach-sign dist/SHA512SUMS",
    "cosign sign-blob --yes --output-signature dist/SHA256SUMS.sig dist/SHA256SUMS",
    "cosign sign-blob --yes --output-signature dist/SHA512SUMS.sig dist/SHA512SUMS",
  ].join("\n");

const spawnStage =
  (
    stage: Pick<ReleaseStage, "id" | "forBinary" | "forLibrary" | "commandSummary" | "remediation">,
    commands: ReadonlyArray<ReadonlyArray<string>>,
  ) =>
  async ({ runner, target }: ReleaseStageContext): Promise<void> => {
    for (const cmd of commands) {
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

    if (stage.id === "11-manifest") {
      await runner.shell({
        stageId: stage.id,
        artifactFamily: artifactFamilyForStage(stage, target),
        summary: stage.commandSummary,
        remediation: stage.remediation,
        script,
      });
      if (
        !credentialGate(
          "11-manifest signing",
          "manifest signing credentials",
          manifestSigningCredentialEnv,
          context,
        )
      ) {
        return;
      }
      await runner.shell({
        stageId: stage.id,
        artifactFamily: artifactFamilyForStage(stage, target),
        summary: "sign release checksum manifests",
        remediation: stage.remediation,
        script: manifestSigningScript(),
      });
      return;
    }

    if (
      stage.id === "13-publish" &&
      !credentialGate(stage.id, "publish credentials", publishCredentialEnv, context)
    ) {
      return;
    }

    await runner.shell({
      stageId: stage.id,
      artifactFamily: artifactFamilyForStage(stage, target),
      summary: stage.commandSummary,
      remediation: stage.remediation,
      script,
    });
  };

const skipStage =
  (stage: Pick<ReleaseStage, "id">, reason: string) =>
  async (context: ReleaseStageContext): Promise<void> => {
    const requirement = credentialSkipRequirements[stage.id];
    if (
      requirement !== undefined &&
      !credentialGate(stage.id, requirement.label, requirement.envNames, context)
    )
      return;
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
  const spawnCommands = Array.isArray(stage.command[0])
    ? (stage.command as ReadonlyArray<ReadonlyArray<string>>)
    : [stage.command as ReadonlyArray<string>];
  const run =
    stage.kind === "spawn"
      ? spawnStage(base, spawnCommands)
      : stage.kind === "shell"
        ? shellStage(base, stage.command as string)
        : skipStage(base, stage.command as string);

  return { ...stage, run };
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
  defineStage({
    id: "7-compile",
    label: "Compile",
    description: "bun build --compile --bytecode --target=bun-${T} bin/lando.ts.",
    forBinary: true,
    forLibrary: false,
    kind: "spawn",
    commandSummary: "bun run --filter=@lando/core build:compile",
    remediation: defaultRemediation,
    command: ["bun", "run", "--filter=@lando/core", "build:compile"],
  }),
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
  defineStage({
    id: "9-sign",
    label: "Sign",
    description: "macOS codesign / Windows signtool. Linux is signed at the manifest layer.",
    forBinary: true,
    forLibrary: false,
    kind: "skip",
    commandSummary: "sign release binaries",
    remediation: "Provision signing credentials or run a local rehearsal mode that may skip signing.",
    command: "[release] skip 9-sign (signing infrastructure not yet provisioned)",
  }),
  defineStage({
    id: "10-notarize",
    label: "Notarize",
    description: "macOS only: notarytool submit + stapler staple.",
    forBinary: true,
    forLibrary: false,
    kind: "skip",
    commandSummary: "notarize macOS release binaries",
    remediation:
      "Provision Apple notarization credentials or run a local rehearsal mode that may skip notarization.",
    command: "[release] skip 10-notarize (notarization infrastructure not yet provisioned)",
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
    command: nonSigningManifestScript(),
  }),
  defineStage({
    id: "12-provenance-sbom",
    label: "Provenance & SBOM",
    description: "CycloneDX SBOM + SLSA provenance + cosign signatures.",
    forBinary: true,
    forLibrary: true,
    kind: "skip",
    commandSummary: "generate provenance and SBOM artifacts",
    remediation: "Implement supply-chain attestation generation before making this stage required.",
    command: "[release] skip 12-provenance-sbom (supply-chain attestations not yet wired)",
  }),
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

const defaultRunner: ReleaseRunner = {
  spawn: async ({ cmd }) => {
    const proc = Bun.spawn([...cmd], { stdout: "inherit", stderr: "inherit" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) throw new Error(`Command exited ${exitCode}: ${cmd.join(" ")}`);
  },
  shell: async ({ stageId, script }) => {
    if (stageId === "13-publish") await prepareNpmAlphaPackages();
    await $`sh -euc ${script}`;
  },
};

export const runRelease = async ({
  target = "all",
  throughStage,
  env = process.env,
  runner = defaultRunner,
  logger = console.log,
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
    try {
      await stage.run({ target, env, localRehearsal, runner, logger });
    } catch (cause) {
      throw new ReleaseStageError(
        stage.id,
        artifactFamilyForStage(stage, target),
        stage.commandSummary,
        stage.remediation,
        cause,
      );
    }
  }

  logger("[release] done.");
};

const main = async (): Promise<void> => {
  await runRelease(parseReleaseOptions(process.argv.slice(2)));
};

if (import.meta.main) await main();
