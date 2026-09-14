import { mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupWorkflowPerformanceSample } from "./workflow-performance-cleanup.ts";

import type {
  WorkflowPerformanceCommand,
  WorkflowPerformanceCommandResult,
} from "./workflow-performance-command.ts";
import { workflowPerformanceDeadlineRunner } from "./workflow-performance-command.ts";
import {
  buildMeasuredCommands,
  performanceCommand,
  runUntilFailure,
  validateJourneyResults,
} from "./workflow-performance-measurement.ts";
import type { WorkflowPerformanceLaneId, WorkflowPerformanceLanePlan } from "./workflow-performance-plan.ts";
import type { WorkflowPerformanceSample } from "./workflow-performance-report.ts";
import { boundedPerformanceEvidence } from "./workflow-performance-report.ts";

const imagesFor = (laneId: WorkflowPerformanceLaneId): readonly string[] => {
  if (laneId.startsWith("mysql-")) return ["mysql:8.0"];
  if (laneId.startsWith("postgres-")) return ["postgres:16"];
  if (laneId === "drupal-journey") return ["php:8.3-apache-bookworm", "mariadb:11.4", "traefik:v3.3"];
  if (laneId === "rails-journey") return ["ruby:3.3-slim", "postgres:16", "redis:7", "traefik:v3.3"];
  return ["node:22"];
};

const landofileFor = (laneId: WorkflowPerformanceLaneId, name: string): string => {
  const type = laneId.startsWith("mysql-")
    ? "mysql:8.0"
    : laneId.startsWith("postgres-")
      ? "postgres:16"
      : "node:22";
  return `name: ${name}\nruntime: 4\nservices:\n  ${type === "node:22" ? "app" : "database"}:\n    type: ${type}\n`;
};

type PreparedSample = {
  readonly appRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly failure?: WorkflowPerformanceCommandResult;
  readonly skipReason?: string;
  readonly fileSyncEvidence: string;
};

type RunSampleInput = {
  readonly signal?: AbortSignal;
  readonly commandTimeoutMs?: number;
  readonly sampleTimeoutMs?: number;
  readonly lane: WorkflowPerformanceLanePlan;
  readonly binary: string;
  readonly rootDir: string;
  readonly index: number;
  readonly key: string;
  readonly fixturePath?: string;
  readonly runCommand: (command: WorkflowPerformanceCommand) => Promise<WorkflowPerformanceCommandResult>;
};

const prepareSample = async (
  input: RunSampleInput,
  acquired: (sample: PreparedSample) => void,
  runtimeRoot: string,
): Promise<PreparedSample> => {
  const { lane, binary, rootDir, key, fixturePath, runCommand } = input;
  const sampleRoot = join(rootDir, "samples", key);
  const appParent = join(sampleRoot, "apps");
  const appRoot = join(appParent, key);
  const dataRoot = join(sampleRoot, "data");
  const storageConfig = join(sampleRoot, "storage.conf");
  const journey = lane.id === "drupal-journey" || lane.id === "rails-journey";
  await mkdir(join(rootDir, "samples"), { recursive: true });
  await mkdir(sampleRoot);
  await Promise.all([
    mkdir(journey ? appParent : appRoot, { recursive: true }),
    mkdir(runtimeRoot, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(
    storageConfig,
    `[storage]\ndriver = "overlay"\n[storage.options.overlay]\nmount_program = "${join(dataRoot, "runtime/bin/fuse-overlayfs")}"\n`,
  );
  const env = {
    ...process.env,
    BUN_BE_BUN: undefined,
    LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
    LANDO_PROVIDER: "lando",
    CONTAINER_HOST: undefined,
    CONTAINER_CONNECTION: undefined,
    DOCKER_HOST: undefined,
    LANDO_USER_CONF_ROOT: join(sampleRoot, "conf"),
    LANDO_USER_DATA_ROOT: dataRoot,
    LANDO_USER_CACHE_ROOT: join(sampleRoot, "cache"),
    CONTAINERS_STORAGE_CONF: storageConfig,
    XDG_RUNTIME_DIR: runtimeRoot,
  };
  const cwd = journey ? appParent : appRoot;
  if (!journey) await writeFile(join(appRoot, ".lando.yml"), landofileFor(lane.id, key));
  acquired({ appRoot, env, fileSyncEvidence: "" });
  const setup = await runCommand(
    performanceCommand(
      "prepare:setup",
      [
        binary,
        "setup",
        "--yes",
        "--provider=lando",
        "--skip-install-ca",
        "--skip-shell-integration",
        "--skip-file-sync",
      ],
      cwd,
      env,
    ),
  );
  if (setup.exitCode !== 0) return { appRoot, env, failure: setup, fileSyncEvidence: setup.stderr };
  if (lane.requiresNativeBindMounts && !setup.stdout.includes("already satisfied (native bind mounts)")) {
    const readiness = setup.stdout.match(/file-sync: (?:deferred|installed|unavailable)\b[^\r\n]*/u)?.[0];
    return readiness === undefined
      ? {
          appRoot,
          env,
          failure: { ...setup, exitCode: 1, stderr: "Setup did not report native bind mount readiness." },
          fileSyncEvidence: setup.stdout,
        }
      : {
          appRoot,
          env,
          skipReason: `Requires native bind mounts; provider readiness reported ${readiness}`,
          fileSyncEvidence: setup.stdout,
        };
  }
  const socket = join(dataRoot, "runtime/run/podman.sock");
  const podman = join(dataRoot, "runtime/bin/podman");
  for (const image of imagesFor(lane.id)) {
    const pulled = await runCommand(
      performanceCommand("prepare:pre-pull", [podman, "--url", `unix://${socket}`, "pull", image], cwd, env),
    );
    if (pulled.exitCode !== 0) return { appRoot, env, failure: pulled, fileSyncEvidence: setup.stdout };
  }
  if (lane.id === "warm-stop-start" || lane.id === "unchanged-rebuild" || lane.fixtureFamily !== undefined) {
    const started = await runCommand(performanceCommand("prepare:start", [binary, "start"], appRoot, env));
    if (started.exitCode !== 0) return { appRoot, env, failure: started, fileSyncEvidence: setup.stdout };
  }
  if (lane.id.endsWith("-snapshot-restore") && fixturePath !== undefined) {
    const prepared = await runUntilFailure(
      [
        performanceCommand(
          "prepare:import",
          [binary, "db:import", fixturePath, "--service", "database", "--yes"],
          appRoot,
          env,
        ),
        performanceCommand(
          "prepare:snapshot",
          [binary, "db:snapshot", "--service", "database", "--label", "workflow-perf-prepared", "--yes"],
          appRoot,
          env,
        ),
      ],
      runCommand,
    );
    const failure = prepared.find((result) => result.exitCode !== 0);
    if (failure !== undefined) return { appRoot, env, failure, fileSyncEvidence: setup.stdout };
  }
  return { appRoot, env, fileSyncEvidence: setup.stdout };
};

export const runWorkflowPerformanceSample = async (
  input: RunSampleInput,
): Promise<
  { readonly fileSyncEvidence: string } & (
    | { readonly sample: WorkflowPerformanceSample }
    | { readonly skipReason: string }
  )
> => {
  await using runtimeDirectory = await mkdtempDisposable(join(tmpdir(), "lp-"));
  const runCommand = workflowPerformanceDeadlineRunner(input);
  let acquired: PreparedSample | undefined;
  const prepared = await prepareSample(
    { ...input, runCommand },
    (sample) => {
      acquired = sample;
    },
    runtimeDirectory.path,
  ).catch((cause: unknown) => {
    if (acquired === undefined) throw cause;
    return {
      ...acquired,
      failure: {
        id: "prepare:failure",
        durationMs: 0,
        exitCode: 1,
        stdout: "",
        stderr: boundedPerformanceEvidence(cause instanceof Error ? cause.message : String(cause)),
      },
    };
  });
  if (prepared.skipReason !== undefined) {
    const failures = await cleanupWorkflowPerformanceSample(
      { binary: input.binary, ...prepared, setupOnly: true },
      input.runCommand,
    );
    return {
      fileSyncEvidence: prepared.fileSyncEvidence,
      ...(failures.length === 0
        ? { skipReason: prepared.skipReason }
        : {
            sample: {
              index: input.index,
              key: input.key,
              outcome: "failed",
              resetCondition: "setup only; lane requirement unmet; runtime cleanup failed",
              steps: failures,
            },
          }),
    };
  }
  const commands = buildMeasuredCommands({
    lane: input.lane,
    binary: input.binary,
    appRoot: prepared.appRoot,
    ...(input.fixturePath === undefined ? {} : { fixturePath: input.fixturePath }),
    env: prepared.env,
  });
  const measured =
    prepared.failure === undefined ? await runUntilFailure(commands, runCommand) : [prepared.failure];
  const steps = validateJourneyResults({
    lane: input.lane,
    binary: input.binary,
    appRoot: prepared.appRoot,
    results: measured,
  });
  const sample: WorkflowPerformanceSample = {
    index: input.index,
    key: input.key,
    outcome:
      steps.length === commands.length && steps.every((step) => step.exitCode === 0) ? "passed" : "failed",
    resetCondition: "fresh Lando config, data, cache, app, and owned volume identities; images pre-pulled",
    steps,
  };
  const cleanupFailures = await cleanupWorkflowPerformanceSample(
    { binary: input.binary, ...prepared, setupOnly: false },
    input.runCommand,
  );
  return {
    sample:
      cleanupFailures.length === 0
        ? sample
        : { ...sample, outcome: "failed", steps: [...sample.steps, ...cleanupFailures] },
    fileSyncEvidence: prepared.fileSyncEvidence,
  };
};
