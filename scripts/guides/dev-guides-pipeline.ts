import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveGeneratedGuideTestRoot } from "../build-guide-scenarios.ts";
import type { TrackTestChild } from "../live-test-roots.ts";
import { withRunnerOwnedTestRoots } from "../test-preload-roots.ts";
import { rewriteScenarioSourceMappedOutput } from "../test-reporters/scenario-source-mapper.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const GENERATOR_PATH = resolve(REPO_ROOT, "scripts/build-guide-scenarios.ts");
const GENERATED_ROOT = resolveGeneratedGuideTestRoot();
const TSC_PATH = resolve(REPO_ROOT, "node_modules/.bin/tsc");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ABORT_EXIT_CODE = 130;

let activeProc: Bun.Subprocess | undefined;
let liveTestInFlight = false;
let shutdownCode = ABORT_EXIT_CODE;
let shuttingDown = false;
const shutdownHooks = new Set<() => void>();

export const requestShutdown = (signal: "SIGINT" | "SIGTERM"): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownCode = signal === "SIGTERM" ? 143 : ABORT_EXIT_CODE;
  if (liveTestInFlight) process.exitCode = shutdownCode;
  activeProc?.kill(signal);
  for (const hook of shutdownHooks) hook();
};

export const isShuttingDown = (): boolean => shuttingDown;

export const onShutdown = (hook: () => void): void => {
  shutdownHooks.add(hook);
};

const run = async (
  cmd: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
  track?: TrackTestChild,
): Promise<RunResult> => {
  if (shuttingDown) {
    return {
      exitCode: shutdownCode,
      stdout: "",
      stderr: "dev:guides: shutdown requested before subprocess start\n",
    };
  }
  const proc = Bun.spawn({
    cmd: [...cmd],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (track === undefined) activeProc = proc;
  else track(proc);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await proc.exited;
    if (activeProc === proc) activeProc = undefined;
  }
};

export const dirExists = async (absolutePath: string): Promise<boolean> => {
  try {
    return (await stat(absolutePath)).isDirectory();
  } catch {
    return false;
  }
};

const generatedDirsFor = async (guideIds: readonly string[]): Promise<readonly string[]> => {
  const present: string[] = [];
  for (const id of guideIds) {
    if (await dirExists(resolve(REPO_ROOT, GENERATED_ROOT, id))) present.push(id);
  }
  return present;
};

export const missingGeneratedGuideIds = (
  guideIds: readonly string[],
  presentIds: readonly string[],
): readonly string[] => {
  const present = new Set(presentIds);
  return guideIds.filter((id) => !present.has(id));
};

const noGeneratedOutput = (guideIds: readonly string[]): RunResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `dev:guides: no generated scenario output found for ${guideIds.join(", ") || "requested guides"}\n`,
});

export const pruneOrphanGeneratedGuides = async (validIds: ReadonlySet<string>): Promise<void> => {
  let entries: readonly string[];
  try {
    entries = await readdir(resolve(REPO_ROOT, GENERATED_ROOT));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (validIds.has(entry)) continue;
    const target = resolve(REPO_ROOT, GENERATED_ROOT, entry);
    if (await dirExists(target)) await rm(target, { force: true, recursive: true });
  }
};

const regenerate = async (guideIds: readonly string[], isAll: boolean): Promise<RunResult> => {
  if (isAll) return run([process.execPath, "run", GENERATOR_PATH]);
  // One parse generates every selected id and clears only their outputs.
  return run([process.execPath, "run", GENERATOR_PATH, ...guideIds.flatMap((id) => ["--only", id])]);
};

const typecheckGuides = async (guideIds: readonly string[]): Promise<RunResult> => {
  if (guideIds.length === 0) return noGeneratedOutput([]);

  const present = await generatedDirsFor(guideIds);
  const missing = missingGeneratedGuideIds(guideIds, present);
  if (missing.length > 0) return noGeneratedOutput(missing);
  const include = present.map((id) => `${resolve(REPO_ROOT, GENERATED_ROOT, id)}/**/*.ts`);
  const configDir = await mkdtemp(join(tmpdir(), "lando-dev-guides-"));
  const configPath = join(configDir, "tsconfig.json");
  const config = {
    extends: resolve(REPO_ROOT, "tsconfig.base.json"),
    compilerOptions: {
      noEmit: true,
      emitDeclarationOnly: false,
      declaration: false,
      declarationMap: false,
      composite: false,
      rootDir: REPO_ROOT,
      typeRoots: [resolve(REPO_ROOT, "node_modules/@types")],
      paths: {
        "@lando/core": [resolve(REPO_ROOT, "core/src/index.ts")],
        "@lando/core/*": [resolve(REPO_ROOT, "core/src/*/index.ts")],
        "@lando/engine": [resolve(REPO_ROOT, "engine/src/index.ts")],
        "@lando/engine/*": [resolve(REPO_ROOT, "engine/src/*.ts")],
        "@lando/sdk": [resolve(REPO_ROOT, "sdk/src/index.ts")],
        "@lando/sdk/*": [resolve(REPO_ROOT, "sdk/src/*")],
      },
    },
    include,
  };
  try {
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return await run([TSC_PATH, "--noEmit", "-p", configPath]);
  } finally {
    await rm(configDir, { force: true, recursive: true });
  }
};

const testGuides = async (guideIds: readonly string[], isAll: boolean): Promise<RunResult> => {
  const runTests = async (targets: readonly string[]) => {
    const command = [process.execPath, "test", ...targets];
    if (process.env.LANDO_GUIDE_E2E !== "1")
      return withRunnerOwnedTestRoots({ env: process.env, live: false }, (env) => run(command, env));
    const { MissingLiveTestBinaryError, runWithLiveTestRoots } = await import("../live-test-roots.ts");
    let output = { stdout: "", stderr: "" };
    liveTestInFlight = true;
    try {
      const exitCode = await runWithLiveTestRoots(
        { live: true, cwd: REPO_ROOT, env: process.env },
        async (env, track) => {
          const result = await run([...command, "--max-concurrency=1"], env, track);
          output = result;
          return result.exitCode;
        },
      );
      return { ...output, exitCode };
    } catch (error) {
      if (error instanceof MissingLiveTestBinaryError) {
        return { stdout: "", stderr: `${error.message}\n`, exitCode: 1 };
      }
      throw error;
    } finally {
      liveTestInFlight = false;
    }
  };
  if (isAll) {
    if (!(await dirExists(resolve(REPO_ROOT, GENERATED_ROOT)))) return noGeneratedOutput([]);
    return runTests([`${GENERATED_ROOT}/`]);
  }
  if (guideIds.length === 0) return noGeneratedOutput([]);

  const present = await generatedDirsFor(guideIds);
  const missing = missingGeneratedGuideIds(guideIds, present);
  if (missing.length > 0) return noGeneratedOutput(missing);
  return runTests(present.map((id) => `${GENERATED_ROOT}/${id}/`));
};

const writeMapped = (result: RunResult): void => {
  if (result.stdout.length > 0) {
    process.stdout.write(
      rewriteScenarioSourceMappedOutput(result.stdout, {
        repoRoot: REPO_ROOT,
        generatedRoot: resolve(REPO_ROOT, GENERATED_ROOT),
      }),
    );
  }
  if (result.stderr.length > 0) {
    process.stderr.write(
      rewriteScenarioSourceMappedOutput(result.stderr, {
        repoRoot: REPO_ROOT,
        generatedRoot: resolve(REPO_ROOT, GENERATED_ROOT),
      }),
    );
  }
};

export const runIteration = async (guideIds: readonly string[], isAll: boolean): Promise<number> => {
  const generated = await regenerate(guideIds, isAll);
  if (generated.exitCode !== 0) {
    process.stderr.write(generated.stderr || generated.stdout);
    return generated.exitCode;
  }

  if (shuttingDown) return shutdownCode;

  const typecheck = await typecheckGuides(guideIds);
  if (typecheck.exitCode !== 0) {
    process.stderr.write(typecheck.stdout || typecheck.stderr);
    return typecheck.exitCode;
  }

  if (shuttingDown) return shutdownCode;

  const tested = await testGuides(guideIds, isAll);
  writeMapped(tested);
  return tested.exitCode;
};
