#!/usr/bin/env bun
import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { type GuideScenarioAst, buildGuideScenarioAst } from "./build-guide-scenarios.ts";
import {
  dirExists,
  isShuttingDown,
  onShutdown,
  pruneOrphanGeneratedGuides,
  requestShutdown,
  runIteration,
} from "./guides/dev-guides-pipeline.ts";
import {
  type AffectedGuidesContext,
  computeAffectedGuides,
  normalize,
  parseDevGuidesArgs,
  uniqueSorted,
} from "./guides/dev-guides-selection.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const GENERATOR_PATH = resolve(import.meta.dirname, "build-guide-scenarios.ts");
const GUIDE_ROOT = "docs/guides";
const DEBOUNCE_MS = 150;

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
  guidePath: string,
): string | undefined => index.guidePathToId.get(guidePath);

const resolvePinnedGuideIds = (
  index: { readonly guidePathToId: ReadonlyMap<string, string> },
  guidePaths: readonly string[],
): { readonly ids?: readonly string[] } | { readonly missing: string } => {
  const ids: string[] = [];
  for (const guidePath of guidePaths) {
    const id = resolveSingleGuideId(index, guidePath);
    if (id === undefined) return { missing: guidePath };
    ids.push(id);
  }
  return ids.length === 0 ? {} : { ids: uniqueSorted(ids) };
};

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

    const pinned = resolvePinnedGuideIds(index, options.guidePaths);
    if ("missing" in pinned) {
      process.stderr.write(`dev:guides: no guide found at ${pinned.missing}\n`);
      process.exitCode = 2;
      return;
    }

    const initialIds = pinned.ids ?? index.allGuideIds;
    const initialIsAll = pinned.ids === undefined;
    initialCode = await runIteration(initialIds, initialIsAll);
  }

  if (options.once) {
    process.exitCode = initialCode;
    return;
  }

  if (isShuttingDown()) return;

  const watchedRoots: string[] = [
    resolve(REPO_ROOT, GUIDE_ROOT),
    resolve(REPO_ROOT, "core/src"),
    resolve(REPO_ROOT, "engine/src"),
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
    if (running || isShuttingDown()) return;
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
      if (isShuttingDown()) return;
      await pruneOrphanGeneratedGuides(new Set(index.allGuideIds));
      if (isShuttingDown()) return;
      const guidePath = options.guidePaths[0];
      const singleGuideId = guidePath === undefined ? undefined : resolveSingleGuideId(index, guidePath);
      if (guidePath !== undefined && singleGuideId === undefined) {
        process.stderr.write(`dev:guides: no guide found at ${guidePath}\n`);
        requeue(changed);
        return;
      }
      const ctx: AffectedGuidesContext =
        singleGuideId === undefined
          ? { allGuideIds: index.allGuideIds, guidePathToId: index.guidePathToId }
          : { allGuideIds: index.allGuideIds, guidePathToId: index.guidePathToId, singleGuideId };
      const affected = uniqueSorted(changed.flatMap((path) => computeAffectedGuides(path, ctx)));
      const isAll = singleGuideId === undefined && affected.length === index.allGuideIds.length;
      if (isShuttingDown()) return;
      await runIteration(affected, isAll);
    } finally {
      running = false;
      if (!isShuttingDown() && pending.size > 0) schedule();
    }
  };

  const schedule = (): void => {
    if (isShuttingDown()) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, DEBOUNCE_MS);
  };

  const isEditorNoise = (basename: string): boolean =>
    basename.endsWith("~") || /\.sw[a-z]$/.test(basename) || basename === "4913";

  const onChange = (baseDir: string, filename: string | null): void => {
    if (isShuttingDown()) return;
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
      if (isShuttingDown()) return;
      pending.add(normalize(relative(REPO_ROOT, GENERATOR_PATH)));
      schedule();
    }),
  );

  process.stderr.write("dev:guides watching for changes (Ctrl-C to exit)\n");

  await new Promise<void>((resolveExit) => {
    if (isShuttingDown()) {
      resolveExit();
      return;
    }
    onShutdown(() => {
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      resolveExit();
    });
  });
};

if (import.meta.main) await main();
