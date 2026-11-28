import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AffectedGuidesSelection, AffectedScenarioVariant } from "./affected-guides.ts";

interface AffectedGuideSummary {
  readonly guides: number;
  readonly variants: number;
  readonly willRun: number;
  readonly skipped: number;
  readonly e2eNotAdmitted: number;
}

/** The one disposition used for listing, counts, and launch. */
export type VariantRunState = "will-run" | "skipped" | "e2e-not-admitted";

export interface PlannedGuideVariant {
  readonly scenarioId: string;
  readonly label: string;
  readonly layer: string;
  readonly state: VariantRunState;
  readonly skip?: { readonly kind: string; readonly reason: string };
}

export interface PlannedGuide {
  readonly guide: string;
  readonly guideId: string;
  readonly reasons: readonly string[];
  readonly variants: readonly PlannedGuideVariant[];
}

const POSIX_E2E_BINARY = "core/dist/lando";
const WINDOWS_E2E_BINARY = "core\\dist\\lando.exe";
const POSIX_E2E_SOCKET = "/path/to/podman.sock";
const WINDOWS_E2E_SOCKET = "\\\\.\\pipe\\podman-lando";

const isWindows = (platform: NodeJS.Platform): boolean => platform === "win32";

interface E2eValue {
  readonly value: string;
  readonly hint?: string;
}

const e2eBinary = (env: NodeJS.ProcessEnv, root: string, platform: NodeJS.Platform): E2eValue => {
  const configured = env.LANDO_SCENARIO_E2E_BINARY;
  if (configured !== undefined && configured !== "") return { value: configured };
  const path = isWindows(platform) ? WINDOWS_E2E_BINARY : POSIX_E2E_BINARY;
  return existsSync(resolve(root, path))
    ? { value: path }
    : {
        value: path,
        hint: `${path} does not exist yet; build it with ${isWindows(platform) ? "bun --cwd=core run build" : "(cd core && bun run build)"}.`,
      };
};

const e2eSocket = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): E2eValue => {
  const configured = env.LANDO_TEST_PODMAN_SOCKET;
  if (configured !== undefined && configured !== "") return { value: configured };
  const path = isWindows(platform) ? WINDOWS_E2E_SOCKET : POSIX_E2E_SOCKET;
  return {
    value: path,
    hint: isWindows(platform)
      ? `LANDO_TEST_PODMAN_SOCKET is unset; replace ${path} with the answering Podman named pipe for this job.`
      : `LANDO_TEST_PODMAN_SOCKET is unset; replace ${path} with an answering Podman API socket for this job.`,
  };
};

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Single-quotes a POSIX value only when the shell would otherwise split it. */
const shellQuote = (value: string): string =>
  SHELL_SAFE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** PowerShell single quotes always quote; an inner quote is doubled. */
const powerShellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const WINDOWS_E2E_HINT =
  "PowerShell $env: assignments last for the rest of this session; remove them with Remove-Item Env:LANDO_GUIDE_E2E, Env:LANDO_SCENARIO_E2E_BINARY, Env:LANDO_TEST_PODMAN_SOCKET.";

interface E2eGuideCommand {
  readonly command: string;
  readonly hints: readonly string[];
}

const e2eGuideCommand = (input: {
  readonly guides: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly root: string;
  readonly platform: NodeJS.Platform;
}): E2eGuideCommand => {
  const binary = e2eBinary(input.env, input.root, input.platform);
  const socket = e2eSocket(input.env, input.platform);
  const windows = isWindows(input.platform);
  const command = windows
    ? [
        "$env:LANDO_GUIDE_E2E='1'",
        `$env:LANDO_SCENARIO_E2E_BINARY=${powerShellQuote(binary.value)}`,
        `$env:LANDO_TEST_PODMAN_SOCKET=${powerShellQuote(socket.value)}`,
        `bun run dev:guides ${input.guides.map(powerShellQuote).join(" ")} --once`,
      ].join("; ")
    : `LANDO_GUIDE_E2E=1 LANDO_SCENARIO_E2E_BINARY=${shellQuote(binary.value)} LANDO_TEST_PODMAN_SOCKET=${shellQuote(socket.value)} bun run dev:guides ${input.guides.map(shellQuote).join(" ")} --once`;
  const hints = [binary.hint, socket.hint].filter((hint): hint is string => hint !== undefined);
  if (windows) hints.push(WINDOWS_E2E_HINT);
  return { command, hints };
};

const e2eAdmitted = (env: NodeJS.ProcessEnv): boolean => env.LANDO_GUIDE_E2E === "1";

const stateOf = (variant: AffectedScenarioVariant, admitted: boolean): VariantRunState => {
  if (variant.skip !== undefined) return "skipped";
  if (variant.layer === "e2e" && !admitted) return "e2e-not-admitted";
  return "will-run";
};

const planGuides = (selection: AffectedGuidesSelection, env: NodeJS.ProcessEnv): readonly PlannedGuide[] => {
  const admitted = e2eAdmitted(env);
  return selection.guides.map((guide) => ({
    guide: guide.guide,
    guideId: guide.guideId,
    reasons: guide.reasons,
    variants: guide.variants.map((variant) => ({
      scenarioId: variant.scenarioId,
      label: variant.label,
      layer: variant.layer,
      state: stateOf(variant, admitted),
      ...(variant.skip === undefined ? {} : { skip: variant.skip }),
    })),
  }));
};

const summarizePlanned = (guides: readonly PlannedGuide[]): AffectedGuideSummary => {
  let variants = 0;
  let willRun = 0;
  let skipped = 0;
  let notAdmitted = 0;
  for (const guide of guides) {
    for (const variant of guide.variants) {
      variants += 1;
      if (variant.state === "skipped") skipped += 1;
      else if (variant.state === "e2e-not-admitted") notAdmitted += 1;
      else willRun += 1;
    }
  }
  return { guides: guides.length, variants, willRun, skipped, e2eNotAdmitted: notAdmitted };
};

/** Summary over the same final disposition the run plan uses. */
export const summarizeAffectedGuides = (
  selection: AffectedGuidesSelection,
  env: NodeJS.ProcessEnv,
): AffectedGuideSummary => summarizePlanned(planGuides(selection, env));

export const notExecutedReason = (summary: AffectedGuideSummary): string => {
  const causes: string[] = [];
  if (summary.skipped > 0)
    causes.push(
      `${summary.skipped} selected guide variant${summary.skipped === 1 ? " is" : "s are"} skipped by rule`,
    );
  if (summary.e2eNotAdmitted > 0)
    causes.push(
      `${summary.e2eNotAdmitted} e2e variant${summary.e2eNotAdmitted === 1 ? " is" : "s are"} not admitted (set LANDO_GUIDE_E2E=1 with LANDO_SCENARIO_E2E_BINARY and LANDO_TEST_PODMAN_SOCKET)`,
    );
  return causes.length === 0
    ? "no unit test file and no home-guide scenario variant was selected"
    : causes.join(" and ");
};

/**
 * One line naming every selected variant that did not run, so neither a human
 * nor an agent can read a partial run as full coverage.
 */
export const notRunLine = (guides: readonly PlannedGuide[]): string | undefined => {
  const segments: string[] = [];
  for (const guide of guides) {
    const notAdmitted = guide.variants.filter((variant) => variant.state === "e2e-not-admitted").length;
    const skipped = guide.variants.filter((variant) => variant.state === "skipped").length;
    if (notAdmitted > 0)
      segments.push(
        `${notAdmitted} e2e variant${notAdmitted === 1 ? "" : "s"} in ${guide.guide} (not admitted)`,
      );
    if (skipped > 0)
      segments.push(
        `${skipped} skipped variant${skipped === 1 ? "" : "s"} in ${guide.guide} (skipped by rule)`,
      );
  }
  return segments.length === 0 ? undefined : `not run: ${segments.join("; ")}`;
};

export interface AffectedGuideRunPlan {
  readonly command?: readonly string[];
  /** The caller's environment, unchanged, so e2e can allocate live roots. */
  readonly env: NodeJS.ProcessEnv;
  readonly e2eCommand?: string;
  readonly e2eHints: readonly string[];
  /** How to rerun the admitted e2e variants, in this platform's shell form. */
  readonly e2eRunNote?: string;
  readonly summary: AffectedGuideSummary;
  /** Guides and variants with the same disposition the counts and launch use. */
  readonly guides: readonly PlannedGuide[];
  /** Every selected variant that will not run, for the closing report. */
  readonly notRun?: string;
}

export const affectedGuideRunPlan = (
  selection: AffectedGuidesSelection,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): AffectedGuideRunPlan => {
  const guides = planGuides(selection, env);
  const summary = summarizePlanned(guides);
  const runnable = guides
    .filter((guide) => guide.variants.some((variant) => variant.state === "will-run"))
    .map((guide) => guide.guide);
  const notRun = notRunLine(guides);
  const e2e =
    summary.e2eNotAdmitted === 0
      ? undefined
      : e2eGuideCommand({
          guides: guides
            .filter((guide) => guide.variants.some((variant) => variant.state === "e2e-not-admitted"))
            .map((guide) => guide.guide),
          env,
          root: selection.root,
          platform,
        });
  return {
    ...(runnable.length === 0
      ? {}
      : { command: [process.execPath, "run", "scripts/dev-guides.ts", "--once", ...runnable] }),
    env,
    ...(e2e === undefined ? {} : { e2eCommand: e2e.command }),
    ...(e2e === undefined
      ? {}
      : {
          e2eRunNote: isWindows(platform)
            ? "Setting the same $env: variables and then running `bun run test:affected --run` runs them too."
            : "Setting the same variables on test:affected --run runs them too.",
        }),
    e2eHints: e2e?.hints ?? [],
    summary,
    guides,
    ...(notRun === undefined ? {} : { notRun }),
  };
};
