import { dirname, join, resolve } from "node:path";

import type ts from "typescript";

import type { BoundaryRule, FileRecord, ProgramContext } from "../types.ts";
import {
  type ModuleProbeBindings,
  analyzeModuleBindings,
  emptyModuleProbeBindings,
  moduleBindingsEqual,
} from "./probe-bindings.ts";
import { scanProbeSource } from "./probe-scan.ts";

const resolveTypeScriptModulePath = (
  fromFile: string,
  moduleSpecifier: string,
  files: ReadonlySet<string>,
): string | undefined => {
  if (!moduleSpecifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), moduleSpecifier);
  return [`${base}.ts`, join(base, "index.ts")].find((candidate) => files.has(candidate));
};

const computeModuleBindings = (
  files: readonly FileRecord[],
  sources: ReadonlyMap<string, ts.SourceFile>,
): ReadonlyMap<string, ModuleProbeBindings> => {
  const absoluteFiles = new Set(files.map((file) => file.absolutePath));
  const cache = new Map<string, ModuleProbeBindings>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of files) {
      const source = sources.get(file.absolutePath);
      if (source === undefined) continue;
      const next = analyzeModuleBindings(source, (fromFile, moduleSpecifier) => {
        const resolved = resolveTypeScriptModulePath(fromFile, moduleSpecifier, absoluteFiles);
        if (resolved === undefined || !sources.has(resolved)) return undefined;
        return cache.get(resolved) ?? emptyModuleProbeBindings();
      });
      const previous = cache.get(file.absolutePath);
      if (previous === undefined || !moduleBindingsEqual(previous, next)) {
        cache.set(file.absolutePath, next);
        changed = true;
      }
    }
  }
  return cache;
};

const onProgram = async (context: ProgramContext): Promise<void> => {
  const sourceEntries = await Promise.all(
    context.files.map(async (file) => [file.absolutePath, await context.sourceFile(file)] as const),
  );
  const sources = new Map(sourceEntries);
  const moduleBindings = computeModuleBindings(context.files, sources);
  for (const file of context.files) {
    const source = sources.get(file.absolutePath);
    if (source === undefined) continue;
    const bindings = moduleBindings.get(file.absolutePath) ?? emptyModuleProbeBindings();
    for (const violation of scanProbeSource(source, bindings)) {
      context.report(file.relativePath, violation.line, violation.detail);
    }
  }
};

export const probeRule = {
  id: "probe",
  scope: {
    roots: ["core/src", "plugins"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Probe boundary check passed.",
  failureHeadline:
    "Probe boundary check failed. Host/provider-shaped retry/backoff/timeout-to-verdict probing must build on @lando/sdk/probe (runProbe), not hand-rolled Effect.retry/repeat/schedule or Schedule loops.",
  onProgram,
} satisfies BoundaryRule;
