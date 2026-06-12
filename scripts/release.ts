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
  readonly runner: ReleaseRunner;
  readonly logger: (line: string) => void;
}

interface ReleaseOptions {
  readonly target?: ArtifactTarget;
  readonly runner?: ReleaseRunner;
  readonly logger?: (line: string) => void;
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

export const parseReleaseTarget = (args: ReadonlyArray<string>): ArtifactTarget => {
  let target: ArtifactTarget | undefined;
  for (const arg of args) {
    if (arg === "--") continue;

    if (!isTargetFlag(arg)) {
      throw new Error(`Unknown release argument: ${arg}`);
    }

    const nextTarget = targetFlags[arg];
    if (target !== undefined && target !== nextTarget) {
      throw new Error(`Conflicting release targets: ${target} and ${nextTarget}`);
    }
    target = nextTarget;
  }

  return target ?? "all";
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

const defaultRemediation = "Fix the failed release stage and rerun scripts/release.ts from a clean tree.";

const spawnStage =
  (
    stage: Pick<ReleaseStage, "id" | "forBinary" | "forLibrary" | "commandSummary" | "remediation">,
    cmd: ReadonlyArray<string>,
  ) =>
  async ({ runner, target }: ReleaseStageContext): Promise<void> => {
    await runner.spawn({
      stageId: stage.id,
      artifactFamily: artifactFamilyForStage(stage, target),
      summary: stage.commandSummary,
      remediation: stage.remediation,
      cmd,
    });
  };

const shellStage =
  (
    stage: Pick<ReleaseStage, "id" | "forBinary" | "forLibrary" | "commandSummary" | "remediation">,
    script: string,
  ) =>
  async ({ logger, runner, target }: ReleaseStageContext): Promise<void> => {
    if (stage.id === "13-publish" && target === "binary") {
      logger("[release] skip 13-publish (binary artifact publishing not yet wired)");
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
  (reason: string) =>
  async ({ logger }: ReleaseStageContext): Promise<void> => {
    logger(reason);
  };

const defineStage = (
  stage: Omit<ReleaseStage, "run"> & {
    readonly command: ReadonlyArray<string> | string;
  },
): ReleaseStage => {
  const base = {
    id: stage.id,
    forBinary: stage.forBinary,
    forLibrary: stage.forLibrary,
    commandSummary: stage.commandSummary,
    remediation: stage.remediation,
  };
  const run =
    stage.kind === "spawn"
      ? spawnStage(base, stage.command as ReadonlyArray<string>)
      : stage.kind === "shell"
        ? shellStage(base, stage.command as string)
        : skipStage(stage.command as string);

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
    commandSummary: "bun run build",
    remediation: defaultRemediation,
    command: ["bun", "run", "build"],
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
    kind: "skip",
    commandSummary: "write release checksum and update manifests",
    remediation: "Implement release manifest generation before making this stage required.",
    command: "[release] skip 11-manifest (manifest signing not yet wired)",
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
  runner = defaultRunner,
  logger = console.log,
}: ReleaseOptions = {}): Promise<void> => {
  const matchingCount = RELEASE_STAGES.filter((stage) => stageMatchesTarget(stage, target)).length;
  logger(`[release] running ${matchingCount}/${RELEASE_STAGES.length} stages for ${target}`);

  for (const stage of RELEASE_STAGES) {
    if (!stageMatchesTarget(stage, target)) {
      logger(`[release] skip ${stage.id} (${target} release target)`);
      continue;
    }

    logger(`[release] -> ${stage.id}: ${stage.description}`);
    try {
      await stage.run({ target, runner, logger });
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
  await runRelease({ target: parseReleaseTarget(process.argv.slice(2)) });
};

if (import.meta.main) await main();
