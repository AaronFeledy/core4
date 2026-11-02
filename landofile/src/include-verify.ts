import { join } from "node:path";
import { taggedErrorJson } from "@lando/sdk/command-result";
import { LandofileLockMismatchError } from "@lando/sdk/errors";
import type { TaggedErrorJson } from "@lando/sdk/schema";
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
import { inspectIncludeComposition } from "./include-load-stage.ts";
import { byCodepointString, lockValue, parseLockEntries } from "./include-lockfile.ts";
import { loadIncludePins } from "./include-pins.ts";
import { resolveTree } from "./include-tree.ts";
import { includeVerifyConditions } from "./include-verify-conditions.ts";
import type { PresentLandofileLayer } from "./layers.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder } from "./load-failures.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type { LandofileRuntimePorts } from "./ports.ts";

export type IncludeVerifyStatus = "ok" | "mismatch" | "missing" | "stale";
export interface IncludeVerifyEntry {
  readonly source: string;
  readonly status: IncludeVerifyStatus;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly condition?: "disabled";
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
  readonly failures: readonly (typeof TaggedErrorJson.Type)[];
  readonly lockfilePath: string;
  readonly entries: ReadonlyArray<IncludeVerifyEntry>;
  readonly mismatches: ReadonlyArray<IncludeVerifyMismatch>;
  readonly ok: boolean;
}
export interface VerifyLandofileIncludesOptions {
  readonly validate?: Effect.Effect<void, ResolveIncludesError>;
  readonly layers?: readonly {
    readonly layer: PresentLandofileLayer;
    readonly landofile: Record<string, unknown>;
  }[];
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
  const recorder = options.loadScope.recorder ?? createLoadFailureRecorder();
  const pins = yield* loadIncludePins({
    pins: parseLockEntries(options.stateStore, options.appRoot, lockfilePath),
    lockfile: lockfilePath,
    recorder,
  });
  const existing = pins.entries;
  const layers = options.layers ?? [
    {
      landofile: options.landofile,
      layer: {
        filePath: join(options.appRoot, ".lando.yml"),
        layer: "canonical" as const,
        order: 3 as const,
      },
    },
  ];
  const conditions = includeVerifyConditions(
    layers.map(({ layer, landofile }) => ({
      file: layer.filePath,
      document: landofile,
    })),
    options.loadScope,
  );
  const ctx: ResolveContext = {
    observeInclude: conditions.observeInclude,
    recorder,
    pendingSites: options.loadScope.pendingSites,
    lockAvailable: pins.available,
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "verify",
    lockEntries: existing,
    loadScope: { ...options.loadScope, includeMode: "all" },
    stagedLocks: new Map(),
    walk: {
      selectors: new Map(),
      issues: new Map(),
      complete: pins.available && recorder.failures.length === 0,
    },
    noNetwork: false,
    loadPolicy: DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  };
  const resolved = [];
  for (const item of layers)
    resolved.push(
      yield* resolveTree(item.landofile, ctx, {
        depth: 0,
        stack: [options.appRoot],
        source: item.layer.filePath,
        layer: item.layer.layer,
        order: item.layer.order,
      }),
    );
  yield* inspectIncludeComposition(resolved, {
    appRoot: options.appRoot,
    scope: { ...options.loadScope, includeMode: "all" },
    recorder,
  });
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
    const disabled = conditions.disabledSources.get(source) === true;
    entries.push({
      source,
      status,
      expected,
      actual,
      ...(disabled ? { condition: "disabled" as const } : {}),
    });
    if (status !== "ok")
      mismatches.push(
        encodeLockMismatch(
          new LandofileLockMismatchError({
            message: verifyMismatchMessage(source, status),
            lockfile: lockfilePath,
            source,
            expected: expected ?? MISSING_LOCK_VALUE,
            actual: actual ?? MISSING_LOCK_VALUE,
            remediation:
              disabled && status === "missing"
                ? "This include is disabled here. Run lando app:includes:update to pin it so every environment resolves the same revision."
                : LOCK_REMEDIATION,
          }),
        ),
      );
  }
  const failures = recorder.failures.map(taggedErrorJson);
  const ok = failures.length === 0 && mismatches.length === 0;
  if (ok) {
    yield* Effect.forEach(recorder.effectiveChecks, (check) => check);
    if (options.validate !== undefined) yield* options.validate;
  }
  return {
    lockfilePath,
    entries,
    mismatches,
    failures,
    ok,
  };
});
