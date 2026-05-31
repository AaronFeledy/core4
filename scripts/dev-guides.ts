#!/usr/bin/env bun
import { type FSWatcher, watch } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { type GuideScenarioAst, buildGuideScenarioAst } from "./build-guide-scenarios.ts";
import { rewriteScenarioSourceMappedOutput } from "./test-reporters/scenario-source-mapper.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GENERATOR_PATH = resolve(import.meta.dirname, "build-guide-scenarios.ts");
const GENERATED_ROOT = "test/scenarios/generated/guides";
const GUIDE_ROOT = "docs/guides";
const TSC_PATH = resolve(REPO_ROOT, "node_modules/.bin/tsc");
const DEBOUNCE_MS = 150;

export interface DevGuidesOptions {
  readonly once: boolean;
  readonly singleGuidePath?: string;
}

export interface AffectedGuidesContext {
  readonly allGuideIds: readonly string[];
  readonly guidePathToId: ReadonlyMap<string, string>;
  readonly singleGuideId?: string;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const ABORT_EXIT_CODE = 130;

let activeProc: Bun.Subprocess | undefined;
let shuttingDown = false;
const shutdownHooks = new Set<() => void>();

const requestShutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  activeProc?.kill();
  for (const hook of shutdownHooks) hook();
};

const normalize = (path: string): string => path.replaceAll("\\", "/");

const uniqueSorted = (ids: readonly string[]): readonly string[] =>
  [...new Set(ids)].sort((left, right) => left.localeCompare(right));

export const parseDevGuidesArgs = (args: ReadonlyArray<string>): DevGuidesOptions => {
  let once = false;
  let singleGuidePath: string | undefined;
  for (const arg of args) {
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown dev:guides flag: ${arg}`);
    if (singleGuidePath !== undefined) throw new Error("dev:guides accepts at most one guide path");
    singleGuidePath = normalize(arg);
  }
  return singleGuidePath === undefined ? { once } : { once, singleGuidePath };
};

/**
 * Maps a changed repo-relative path to the guide ids whose scenarios it affects.
 * A guide MDX change affects only that guide; a production-source or generator
 * change affects every guide. Single-guide mode pins every change to one guide.
 */
export const computeAffectedGuides = (changedPath: string, ctx: AffectedGuidesContext): readonly string[] => {
  if (ctx.singleGuideId !== undefined) return [ctx.singleGuideId];
  const mapped = ctx.guidePathToId.get(normalize(changedPath));
  if (mapped !== undefined) return [mapped];
  return uniqueSorted(ctx.allGuideIds);
};

const run = async (
  cmd: ReadonlyArray<string>,
  env: Record<string, string | undefined> = {},
): Promise<RunResult> => {
  if (shuttingDown) {
    return {
      exitCode: ABORT_EXIT_CODE,
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
  activeProc = proc;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (activeProc === proc) activeProc = undefined;
  }
};

const dirExists = async (absolutePath: string): Promise<boolean> => {
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

const pluginSrcRoots = async (): Promise<readonly string[]> => {
  const roots: string[] = [];
  let entries: readonly string[] = [];
  try {
    entries = await readdir(resolve(REPO_ROOT, "plugins"));
  } catch {
    return roots;
  }
  for (const entry of entries) {
    const src = resolve(REPO_ROOT, "plugins", entry, "src");
    if (await dirExists(src)) roots.push(src);
  }
  return roots;
};

const regenerate = async (guideIds: readonly string[], isAll: boolean): Promise<RunResult> => {
  if (isAll) return run([process.execPath, "run", GENERATOR_PATH]);
  let last: RunResult = { exitCode: 0, stdout: "", stderr: "" };
  for (const id of guideIds) {
    last = await run([process.execPath, "run", GENERATOR_PATH, "--only", id]);
    if (last.exitCode !== 0) return last;
  }
  return last;
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
      baseUrl: REPO_ROOT,
      rootDir: REPO_ROOT,
      typeRoots: [resolve(REPO_ROOT, "node_modules/@types")],
      paths: {
        "@lando/core": ["core/src/index.ts"],
        "@lando/core/*": ["core/src/*/index.ts"],
        "@lando/sdk": ["sdk/src/index.ts"],
        "@lando/sdk/*": ["sdk/src/*"],
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
  if (isAll) {
    if (!(await dirExists(resolve(REPO_ROOT, GENERATED_ROOT)))) return noGeneratedOutput([]);
    return run([process.execPath, "test", `${GENERATED_ROOT}/`]);
  }
  if (guideIds.length === 0) return noGeneratedOutput([]);

  const present = await generatedDirsFor(guideIds);
  const missing = missingGeneratedGuideIds(guideIds, present);
  if (missing.length > 0) return noGeneratedOutput(missing);
  return run([process.execPath, "test", ...present.map((id) => `${GENERATED_ROOT}/${id}/`)]);
};

const writeMapped = (result: RunResult): void => {
  if (result.stdout.length > 0) {
    process.stdout.write(rewriteScenarioSourceMappedOutput(result.stdout, { repoRoot: REPO_ROOT }));
  }
  if (result.stderr.length > 0) {
    process.stderr.write(rewriteScenarioSourceMappedOutput(result.stderr, { repoRoot: REPO_ROOT }));
  }
};

const runIteration = async (guideIds: readonly string[], isAll: boolean): Promise<number> => {
  const generated = await regenerate(guideIds, isAll);
  if (generated.exitCode !== 0) {
    process.stderr.write(generated.stderr || generated.stdout);
    return generated.exitCode;
  }

  if (shuttingDown) return ABORT_EXIT_CODE;

  const typecheck = await typecheckGuides(guideIds);
  if (typecheck.exitCode !== 0) {
    process.stderr.write(typecheck.stdout || typecheck.stderr);
    return typecheck.exitCode;
  }

  if (shuttingDown) return ABORT_EXIT_CODE;

  const tested = await testGuides(guideIds, isAll);
  writeMapped(tested);
  return tested.exitCode;
};

const buildGuideIndex = async (): Promise<{
  readonly asts: ReadonlyArray<GuideScenarioAst>;
  readonly allGuideIds: readonly string[];
  readonly guidePathToId: ReadonlyMap<string, string>;
}> => {
  const asts = await buildGuideScenarioAst(REPO_ROOT);
  const guidePathToId = new Map<string, string>();
  for (const guide of asts) guidePathToId.set(normalize(guide.sourcePath), guide.frontmatter.id);
  return {
    asts,
    allGuideIds: uniqueSorted(asts.map((guide) => guide.frontmatter.id)),
    guidePathToId,
  };
};

const writeError = (prefix: string, error: unknown): void => {
  const detail = error instanceof Error ? error.stack || error.message : JSON.stringify(error, null, 2);
  process.stderr.write(`${prefix}: ${detail ?? String(error)}\n`);
};

const resolveSingleGuideId = (
  index: { readonly guidePathToId: ReadonlyMap<string, string> },
  singleGuidePath: string,
): string | undefined => index.guidePathToId.get(singleGuidePath);

const main = async (): Promise<void> => {
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  const options = parseDevGuidesArgs(Bun.argv.slice(2));
  let index: Awaited<ReturnType<typeof buildGuideIndex>> = {
    asts: [],
    allGuideIds: [],
    guidePathToId: new Map(),
  };
  let indexReady = false;

  try {
    index = await buildGuideIndex();
    indexReady = true;
  } catch (error) {
    writeError("dev:guides: failed to build guide index", error);
    if (options.once) {
      process.exitCode = 1;
      return;
    }
  }

  let initialCode = 1;
  if (indexReady) {
    await pruneOrphanGeneratedGuides(new Set(index.allGuideIds));

    const singleGuideId =
      options.singleGuidePath === undefined
        ? undefined
        : resolveSingleGuideId(index, options.singleGuidePath);
    if (options.singleGuidePath !== undefined && singleGuideId === undefined) {
      process.stderr.write(`dev:guides: no guide found at ${options.singleGuidePath}\n`);
      process.exitCode = 2;
      return;
    }

    const initialIds = singleGuideId === undefined ? index.allGuideIds : [singleGuideId];
    const initialIsAll = singleGuideId === undefined;
    initialCode = await runIteration(initialIds, initialIsAll);
  }

  if (options.once) {
    process.exitCode = initialCode;
    return;
  }

  if (shuttingDown) return;

  const watchedRoots: string[] = [
    resolve(REPO_ROOT, GUIDE_ROOT),
    resolve(REPO_ROOT, "core/src"),
    resolve(REPO_ROOT, "sdk/src"),
    ...(await pluginSrcRoots()),
  ];
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const requeue = (changed: readonly string[]): void => {
    for (const path of changed) pending.add(path);
  };

  const flush = async (): Promise<void> => {
    if (running || shuttingDown) return;
    if (pending.size === 0) return;
    running = true;
    const changed = [...pending];
    pending.clear();
    try {
      try {
        index = await buildGuideIndex();
        indexReady = true;
      } catch (error) {
        indexReady = false;
        writeError("dev:guides: failed to build guide index", error);
        requeue(changed);
        return;
      }
      if (shuttingDown) return;
      await pruneOrphanGeneratedGuides(new Set(index.allGuideIds));
      if (shuttingDown) return;
      const singleGuideId =
        options.singleGuidePath === undefined
          ? undefined
          : resolveSingleGuideId(index, options.singleGuidePath);
      if (options.singleGuidePath !== undefined && singleGuideId === undefined) {
        process.stderr.write(`dev:guides: no guide found at ${options.singleGuidePath}\n`);
        requeue(changed);
        return;
      }
      const ctx: AffectedGuidesContext =
        singleGuideId === undefined
          ? { allGuideIds: index.allGuideIds, guidePathToId: index.guidePathToId }
          : { allGuideIds: index.allGuideIds, guidePathToId: index.guidePathToId, singleGuideId };
      const affected = uniqueSorted(changed.flatMap((path) => computeAffectedGuides(path, ctx)));
      const isAll = singleGuideId === undefined && affected.length === index.allGuideIds.length;
      if (shuttingDown) return;
      await runIteration(affected, isAll);
    } finally {
      running = false;
      if (!shuttingDown && pending.size > 0) schedule();
    }
  };

  const schedule = (): void => {
    if (shuttingDown) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  };

  const isEditorNoise = (basename: string): boolean =>
    basename.endsWith("~") || /\.sw[a-z]$/.test(basename) || basename === "4913";

  const onChange = (baseDir: string, filename: string | null): void => {
    if (shuttingDown) return;
    if (filename === null) {
      pending.add(normalize(relative(REPO_ROOT, baseDir)));
      schedule();
      return;
    }
    const basename = filename.split("/").pop() ?? filename;
    if (isEditorNoise(basename)) return;
    pending.add(normalize(relative(REPO_ROOT, resolve(baseDir, filename))));
    schedule();
  };

  for (const root of watchedRoots) {
    if (!(await dirExists(root))) continue;
    watchers.push(watch(root, { recursive: true }, (_event, filename) => onChange(root, filename)));
  }
  watchers.push(
    watch(GENERATOR_PATH, () => {
      if (shuttingDown) return;
      pending.add(normalize(relative(REPO_ROOT, GENERATOR_PATH)));
      schedule();
    }),
  );

  process.stderr.write("dev:guides watching for changes (Ctrl-C to exit)\n");

  await new Promise<void>((resolveExit) => {
    if (shuttingDown) {
      resolveExit();
      return;
    }
    shutdownHooks.add(() => {
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      resolveExit();
    });
  });
};

if (import.meta.main) await main();
