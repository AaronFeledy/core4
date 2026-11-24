#!/usr/bin/env bun
/**
 * `bun run bootstrap`: make a fresh checkout or worktree ready for typecheck, tests, and
 * `cd core && bun run build` with one command. It installs dependencies, runs codegen, builds
 * the SDK, then restores the container helper from the per-user cache keyed by its source digest
 * (`scripts/container-helper-cache.ts`). A cache miss does not start the multi-minute provider
 * build unless `--build-helper` asks for it; the report names that command instead.
 *
 * Runs before `bun install`, so this file imports only Bun and Node built-ins; workspace modules
 * load after the install step.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const BUILD_HELPER_FLAG = "--build-helper";
const HELPER_BUILD_COMMAND = `bun run bootstrap ${BUILD_HELPER_FLAG}`;

type StepStatus = "ok" | "failed" | "skipped";
interface StepReport {
  readonly id: string;
  readonly status: StepStatus;
  readonly seconds?: number;
  readonly log?: string;
}
interface HelperReport {
  readonly status: "current" | "restored" | "built" | "missing" | "failed" | "skipped";
  readonly sourceDigest?: string;
  readonly detail?: string;
}
interface BootstrapReport {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<StepReport>;
  readonly helper: HelperReport;
  readonly next?: string;
}

const args = new Set(Bun.argv.slice(2));
for (const arg of args)
  if (arg !== BUILD_HELPER_FLAG && arg !== "--json") {
    process.stderr.write(
      `Unknown argument: ${arg}\nUsage: bun run bootstrap [${BUILD_HELPER_FLAG}] [--json]\n`,
    );
    process.exit(2);
  }

const logDir = await mkdtemp(join(tmpdir(), "lando-bootstrap-"));
const TAIL_LINES = 30;

/** Each step's combined output goes to its own log; stdout carries only the final report. */
const run = async (id: string, argv: ReadonlyArray<string>): Promise<{ exitCode: number; log: string }> => {
  const log = join(logDir, `${id.replaceAll(" ", "-")}.log`);
  const output = Bun.file(log);
  const child = Bun.spawn({
    cmd: [process.execPath, ...argv],
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: output,
    stderr: output,
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    const tail = (await output.text()).trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
    process.stderr.write(
      `--- ${id} failed (exit ${exitCode}); last ${TAIL_LINES} lines of ${log} ---\n${tail}\n`,
    );
  }
  return { exitCode, log };
};

const steps: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["install", ["install"]],
  ["codegen", ["run", "codegen"]],
  ["sdk build", ["run", "--filter=@lando/sdk", "build"]],
];

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const prepareHelper = async (): Promise<HelperReport> => {
  const [{ containerHelperSourceDigest }, cache] = await Promise.all([
    import("@lando/container-runtime/container-helper/source"),
    import("./container-helper-cache.ts"),
  ]);
  const target = {
    dist: join(REPO_ROOT, "core/container-helper/dist"),
    sourceDigest: await containerHelperSourceDigest(),
    cacheRoot: cache.defaultContainerHelperCacheRoot(),
  };
  let restored: Awaited<ReturnType<typeof cache.restoreContainerHelper>>;
  try {
    restored = await cache.restoreContainerHelper(target);
  } catch (cause) {
    return {
      status: "failed",
      sourceDigest: target.sourceDigest,
      detail: `restore failed: ${message(cause)}`,
    };
  }
  if (restored.status === "current") {
    // Seed the shared cache from a checkout that already built this digest; the checkout is ready either way.
    const detail = await cache.publishContainerHelper(target).then(
      (published) => (published === "published" ? `published to ${target.cacheRoot}` : "cached"),
      (cause: unknown) => `not cached: ${message(cause)}`,
    );
    return { status: "current", sourceDigest: target.sourceDigest, detail };
  }
  if (restored.status === "restored")
    return { status: "restored", sourceDigest: target.sourceDigest, detail: restored.entry };
  if (!args.has(BUILD_HELPER_FLAG))
    return { status: "missing", sourceDigest: target.sourceDigest, detail: restored.reason };
  // build:container-helper publishes its output to the cache itself.
  const { exitCode, log } = await run("container helper", [
    "run",
    "--filter=@lando/core",
    "build:container-helper",
  ]);
  return exitCode === 0
    ? { status: "built", sourceDigest: target.sourceDigest }
    : {
        status: "failed",
        sourceDigest: target.sourceDigest,
        detail: `build:container-helper exited ${exitCode} (log: ${log}); it needs a working provider (\`bun core/bin/lando.ts setup\`)`,
      };
};

const bootstrap = async (): Promise<BootstrapReport> => {
  const reports: StepReport[] = [];
  for (const [id, argv] of steps) {
    if (reports.some((step) => step.status === "failed")) {
      reports.push({ id, status: "skipped" });
      continue;
    }
    const started = performance.now();
    const { exitCode, log } = await run(id, argv);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    reports.push(exitCode === 0 ? { id, status: "ok", seconds } : { id, status: "failed", seconds, log });
  }
  const failed = reports.find((step) => step.status === "failed");
  if (failed !== undefined)
    return { ok: false, steps: reports, helper: { status: "skipped" }, next: "bun run bootstrap" };
  const helper = await prepareHelper();
  const ready = helper.status === "current" || helper.status === "restored" || helper.status === "built";
  return { ok: ready, steps: reports, helper, ...(ready ? {} : { next: HELPER_BUILD_COMMAND }) };
};

const renderText = (report: BootstrapReport): string => {
  const lines = ["Bootstrap report"];
  for (const step of report.steps)
    lines.push(
      `  ${step.id.padEnd(16)} ${step.status}${step.seconds === undefined ? "" : ` (${step.seconds}s)`}${step.status === "failed" ? ` log: ${step.log}` : ""}`,
    );
  const digest =
    report.helper.sourceDigest === undefined ? "" : ` [${report.helper.sourceDigest.slice(0, 12)}]`;
  const detail = report.helper.detail === undefined ? "" : `: ${report.helper.detail}`;
  lines.push(`  ${"container helper".padEnd(16)} ${report.helper.status}${digest}${detail}`);
  lines.push(
    report.ok
      ? "Ready: bun run typecheck, bun test, cd core && bun run build"
      : `Not ready. Next: ${report.next ?? "bun run bootstrap"}`,
  );
  return `${lines.join("\n")}\n`;
};

const report = await bootstrap();
// Keep the logs only when a step failed and they need reading.
if (!report.steps.some((step) => step.status === "failed") && report.helper.status !== "failed")
  await rm(logDir, { recursive: true, force: true });
process.stdout.write(args.has("--json") ? `${JSON.stringify(report)}\n` : renderText(report));
process.exitCode = report.ok ? 0 : 1;
