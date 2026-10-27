import { join } from "node:path";
import { LandofileLockMismatchError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import {
  LOCK_REMEDIATION,
  type LandofileIncludeDeps,
  type ResolveContext,
  type ResolveIncludesError,
  resolveCacheRoot,
} from "./include-context.ts";
import { byCodepointString, lockValue, parseLockEntries } from "./include-lockfile.ts";
import { authoredIncludeEntries } from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type { LandofileRuntimePorts } from "./ports.ts";

export type IncludeVerifyStatus = "ok" | "mismatch" | "missing" | "stale";
export interface IncludeVerifyEntry {
  readonly source: string;
  readonly status: IncludeVerifyStatus;
  readonly expected: string | null;
  readonly actual: string | null;
}
export interface IncludeVerifyMismatch {
  readonly _tag: "LandofileLockMismatchError";
  readonly message: string;
  readonly lockfile: string;
  readonly source: string;
  readonly expected: string;
  readonly actual: string;
  readonly remediation: string;
}
export interface IncludeVerifyReport {
  readonly lockfilePath: string;
  readonly entries: ReadonlyArray<IncludeVerifyEntry>;
  readonly mismatches: ReadonlyArray<IncludeVerifyMismatch>;
  readonly ok: boolean;
}
export interface VerifyLandofileIncludesOptions {
  readonly loadScope: LandofileLoadScope;
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
  readonly ports?: LandofileRuntimePorts;
  readonly stateStore?: StateStoreShape;
}
const MISSING_LOCK_VALUE = "<missing>";
const encodeLockMismatch = Schema.encodeSync(LandofileLockMismatchError);
const verifyMismatchMessage = (source: string, status: IncludeVerifyStatus): string => {
  if (status === "missing") return `Landofile include ${source} is not recorded in the lockfile.`;
  if (status === "stale") return `Lockfile entry ${source} no longer matches a resolved include.`;
  return `Landofile include lock mismatch for ${source}.`;
};
export const verifyLandofileIncludes = Effect.fn("Landofile.verifyIncludes")(function* (
  options: VerifyLandofileIncludesOptions,
): Effect.fn.Return<IncludeVerifyReport, ResolveIncludesError> {
  const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
  const existing = yield* parseLockEntries(options.stateStore, options.appRoot, lockfilePath);
  const includes = authoredIncludeEntries(options.landofile);
  const ctx: ResolveContext = {
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "verify",
    lockEntries: existing,
    loadScope: options.loadScope,
    stagedLocks: new Map(),
    walk: { selectors: new Map(), issues: new Map(), complete: true },
    noNetwork: false,
    loadPolicy: DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  };
  if (includes.length > 0)
    yield* resolveTree(
      options.landofile,
      ctx,
      0,
      [options.appRoot],
      join(options.appRoot, ".lando.yml"),
      "canonical",
      3,
    );
  const staged = ctx.stagedLocks;
  const sources = [
    ...new Set([...(ctx.walk.complete ? existing.keys() : []), ...staged.keys(), ...ctx.walk.issues.keys()]),
  ].sort(byCodepointString);
  const entries: IncludeVerifyEntry[] = [];
  const mismatches: IncludeVerifyMismatch[] = [];
  for (const source of sources) {
    const lock = existing.get(source);
    const fresh = staged.get(source);
    const issue = ctx.walk.issues.get(source);
    const expected = issue === undefined ? (lock === undefined ? null : lockValue(lock)) : issue.expected;
    const actual = issue === undefined ? (fresh === undefined ? null : lockValue(fresh)) : issue.actual;
    const status: IncludeVerifyStatus =
      issue?.status ??
      (lock !== undefined && fresh !== undefined
        ? lock.version === fresh.version &&
          lock.resolved === fresh.resolved &&
          lock.checksum === fresh.checksum
          ? "ok"
          : "mismatch"
        : fresh !== undefined
          ? "missing"
          : "stale");
    entries.push({ source, status, expected, actual });
    if (status !== "ok")
      mismatches.push(
        encodeLockMismatch(
          new LandofileLockMismatchError({
            message: verifyMismatchMessage(source, status),
            lockfile: lockfilePath,
            source,
            expected: expected ?? MISSING_LOCK_VALUE,
            actual: actual ?? MISSING_LOCK_VALUE,
            remediation: LOCK_REMEDIATION,
          }),
        ),
      );
  }
  return { lockfilePath, entries, mismatches, ok: mismatches.length === 0 };
});
