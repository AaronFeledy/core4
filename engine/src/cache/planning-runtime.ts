import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

import { CORE_VERSION } from "../version.ts";

declare const __LANDO_CORE_VERSION__: string | undefined;

export interface PlanningRuntimeParts {
  readonly coreVersion: string;
  readonly compiledExec?: { readonly size: number; readonly mtimeMs: number };
  readonly bundledSource?: string;
}

interface BundledSourceEntry {
  readonly package: "engine" | "service-lando";
  readonly path: string;
  readonly sha256: string;
}

const sha256Hex = (payload: Uint8Array | string): string =>
  createHash("sha256").update(payload).digest("hex");

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
};

const stableStringify = (value: unknown): string => JSON.stringify(stable(value));

const compiledVersionDefined = (): boolean =>
  typeof __LANDO_CORE_VERSION__ === "string" && __LANDO_CORE_VERSION__.length > 0;

const compiledExecStamp = (): PlanningRuntimeParts["compiledExec"] => {
  if (!compiledVersionDefined()) return undefined;
  try {
    const stats = statSync(process.execPath);
    return { size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) };
  } catch {
    return undefined;
  }
};

const posixRelative = (root: string, file: string): string => relative(root, file).split(sep).join("/");

const collectTsFiles = (dir: string, files: string[]): void => {
  let entries: ReadonlyArray<import("node:fs").Dirent>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(full, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    files.push(full);
  }
};

const digestTree = (
  packageName: BundledSourceEntry["package"],
  root: string,
  trees: ReadonlyArray<string>,
): ReadonlyArray<BundledSourceEntry> => {
  const files: string[] = [];
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    collectTsFiles(tree, files);
  }
  return files.map((file) => ({
    package: packageName,
    path: posixRelative(root, file),
    sha256: sha256Hex(readFileSync(file)),
  }));
};

const resolvePackageRoot = (requireId: string, climb = 0): string | undefined => {
  try {
    let resolved = createRequire(join(process.cwd(), "package.json")).resolve(requireId);
    for (let step = 0; step < climb; step += 1) {
      resolved = dirname(resolved);
    }
    return resolved;
  } catch {
    return undefined;
  }
};

const bundledSourceDigest = (): string | undefined => {
  const engineRoot = resolvePackageRoot("@lando/engine/package.json", 1);
  const serviceLandoRoot = resolvePackageRoot("@lando/service-lando", 2);
  const entries: BundledSourceEntry[] = [];
  if (engineRoot !== undefined) {
    entries.push(
      ...digestTree("engine", engineRoot, [
        join(engineRoot, "src", "planner"),
        join(engineRoot, "src", "cache"),
      ]),
    );
  }
  if (serviceLandoRoot !== undefined && existsSync(join(serviceLandoRoot, "src"))) {
    entries.push(...digestTree("service-lando", serviceLandoRoot, [join(serviceLandoRoot, "src")]));
  }
  if (entries.length === 0) return undefined;
  return sha256Hex(
    stableStringify(
      entries.sort(
        (left, right) => left.package.localeCompare(right.package) || left.path.localeCompare(right.path),
      ),
    ),
  );
};

export const computePlanningRuntimeParts = (): PlanningRuntimeParts => {
  const compiledExec = compiledExecStamp();
  const bundledSource = bundledSourceDigest();
  return {
    coreVersion: CORE_VERSION,
    ...(compiledExec === undefined ? {} : { compiledExec }),
    ...(bundledSource === undefined ? {} : { bundledSource }),
  };
};

export const fingerprintPlanningRuntimeParts = (parts: PlanningRuntimeParts): string =>
  sha256Hex(stableStringify(parts));

export const computePlanningRuntimeIdentity = (): string =>
  fingerprintPlanningRuntimeParts(computePlanningRuntimeParts());

let memoizedIdentity: string | undefined;

export const defaultPlanningRuntimeIdentity = (): string => {
  memoizedIdentity ??= computePlanningRuntimeIdentity();
  return memoizedIdentity;
};
