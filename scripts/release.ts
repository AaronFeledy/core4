#!/usr/bin/env bun
/**
 * Lando v4 release orchestrator — runs the build pipeline.
 *
 * One ordered sequence produces the two artifact families:
 *   1. compiled binaries (one per platform target)
 *   2. library package (`@lando/core` published to npm)
 *
 * this orchestrator MAY use `Bun.$` directly because it runs
 * outside `LandoRuntimeLive`. Production source under `core/src/` still routes
 * shell-shaped work through `ShellRunner` for redaction, lifecycle events,
 * and pluggability.
 *
 * Status: SCAFFOLDING. Stages 9–13 (sign / notarize / manifest / SBOM /
 * publish) are stubs and exit successfully without doing real work; they
 * land alongside the signing/notarization secrets and supply-chain pipeline.
 */
import { $ } from "bun";

interface Stage {
  readonly id: string;
  readonly description: string;
  readonly forBinary: boolean;
  readonly forLibrary: boolean;
  readonly status: "ready" | "stub";
  readonly run: () => Promise<void>;
}

type ArtifactTarget = "all" | "binary" | "library";

const targetFlags = {
  "--all": "all",
  "--binary": "binary",
  "--binary-only": "binary",
  "--library": "library",
  "--library-only": "library",
} satisfies Record<string, ArtifactTarget>;

const isTargetFlag = (arg: string): arg is keyof typeof targetFlags => arg in targetFlags;

const parseTarget = (args: ReadonlyArray<string>): ArtifactTarget => {
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

const stageMatchesTarget = (stage: Stage, target: ArtifactTarget): boolean => {
  if (target === "all") return true;
  if (target === "binary") return stage.forBinary;
  return stage.forLibrary;
};

const skip = async (id: string, reason: string): Promise<void> => {
  console.log(`[release] skip ${id} (${reason})`);
};

const stages: ReadonlyArray<Stage> = [
  {
    id: "1-codegen",
    description: "Run scripts/codegen.ts to refresh every generated file.",
    forBinary: true,
    forLibrary: true,
    status: "ready",
    run: async () => {
      await $`bun run scripts/codegen.ts`;
    },
  },
  {
    id: "2-typecheck",
    description: "tsc -b across the workspace.",
    forBinary: true,
    forLibrary: true,
    status: "ready",
    run: async () => {
      await $`bun run typecheck`;
    },
  },
  {
    id: "3-lint",
    description: "biome check (lint + format).",
    forBinary: true,
    forLibrary: true,
    status: "ready",
    run: async () => {
      await $`bun run lint`;
    },
  },
  {
    id: "4-test",
    description: "bun test (unit + library + scenario + smoke).",
    forBinary: true,
    forLibrary: true,
    status: "ready",
    run: async () => {
      await $`bun test`;
    },
  },
  {
    id: "5-schema-artifacts",
    description: "Generate dist/schemas/*.json + dist/types/*.d.ts.",
    forBinary: true,
    forLibrary: true,
    status: "stub",
    run: () => skip("5-schema-artifacts", "scripts/build-schema-json.ts not yet implemented"),
  },
  {
    id: "6-library-bundle",
    description: "bun build (no --compile) per package.json#exports entry.",
    forBinary: false,
    forLibrary: true,
    status: "ready",
    run: async () => {
      await $`bun run --filter='@lando/core' build`;
    },
  },
  {
    id: "7-compile",
    description: "bun build --compile --bytecode --target=bun-${T} bin/lando.ts.",
    forBinary: true,
    forLibrary: false,
    status: "ready",
    run: async () => {
      await $`bun run --filter='@lando/core' build:compile`;
    },
  },
  {
    id: "8-strip",
    description: "Remove debug symbols where the platform supports it.",
    forBinary: true,
    forLibrary: false,
    status: "stub",
    run: () => skip("8-strip", "platform-specific stripping not yet wired"),
  },
  {
    id: "9-sign",
    description: "macOS codesign / Windows signtool. Linux is signed at the manifest layer.",
    forBinary: true,
    forLibrary: false,
    status: "stub",
    run: () => skip("9-sign", "signing infrastructure not yet provisioned"),
  },
  {
    id: "10-notarize",
    description: "macOS only: notarytool submit + stapler staple.",
    forBinary: true,
    forLibrary: false,
    status: "stub",
    run: () => skip("10-notarize", "notarization infrastructure not yet provisioned"),
  },
  {
    id: "11-manifest",
    description: "Write SHA256SUMS, SHA512SUMS, GPG-sign, write update-manifest.json.",
    forBinary: true,
    forLibrary: true,
    status: "stub",
    run: () => skip("11-manifest", "manifest signing not yet wired"),
  },
  {
    id: "12-provenance",
    description: "CycloneDX SBOM + SLSA provenance + cosign signatures.",
    forBinary: true,
    forLibrary: true,
    status: "stub",
    run: () => skip("12-provenance", "supply-chain attestations not yet wired"),
  },
  {
    id: "13-publish",
    description: "Upload to GitHub Releases (binaries + manifests) and npm (library).",
    forBinary: true,
    forLibrary: true,
    status: "stub",
    run: () => skip("13-publish", "publishing handled by the release.yml workflow until 9–12 are wired"),
  },
];

const main = async (): Promise<void> => {
  const target = parseTarget(process.argv.slice(2));
  const selectedStages = stages.filter((stage) => stageMatchesTarget(stage, target));
  console.log(`[release] running ${selectedStages.length}/${stages.length} stages for ${target}`);
  for (const stage of stages) {
    if (!stageMatchesTarget(stage, target)) {
      await skip(stage.id, `${target} release target`);
      continue;
    }
    console.log(`[release] -> ${stage.id}: ${stage.description}`);
    await stage.run();
  }
  console.log("[release] done.");
};

await main();
