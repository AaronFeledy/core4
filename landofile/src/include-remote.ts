import { LandofileLockMismatchError } from "@lando/sdk/errors";
import { displaySource } from "@lando/source-acquisition";
import { Effect } from "effect";
import type { FragmentResult, NormalizedInclude, ResolveContext } from "./include-context.ts";
import { LOCK_REMEDIATION } from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import { RESOLVED_FORMAT, readPinnedFragment } from "./include-pinned.ts";
import { parseGitInclude, parseNpmInclude } from "./include-source.ts";
import { mapSourceAcquisitionError, requiredSourceSession, runSource } from "./include-sources.ts";

export const fetchGit = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<FragmentResult | undefined> => {
  const parsed = parseGitInclude(entry);
  const session = await requiredSourceSession(ctx, signal);
  const fragment = await readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.ref,
    cacheKind: "git",
    fragmentRelPath: parsed.path,
    openCached: (commit) => runSource(session.openGit(commit), signal),
    acquire: async (resolved, options) => {
      if (resolved !== undefined) {
        return Effect.runPromise(
          session.materializeGit({ url: parsed.cloneUrl, commit: resolved }).pipe(
            Effect.mapError((error) => {
              if (error.expected === undefined || error.actual === undefined)
                return mapSourceAcquisitionError(error);
              return new LandofileLockMismatchError({
                message: displaySource(
                  `Landofile include lock mismatch for ${parsed.sourceId}: locked ${error.expected}, found ${error.actual}.`,
                ),
                lockfile: ctx.lockfilePath,
                source: displaySource(parsed.sourceId),
                expected: error.expected,
                actual: error.actual,
                remediation: LOCK_REMEDIATION,
              });
            }),
          ),
          { signal },
        );
      }
      return runSource(
        session.acquireGit(
          { url: parsed.cloneUrl, ...(parsed.ref === undefined ? {} : { ref: parsed.ref }) },
          { repair: options.repair },
        ),
        signal,
      );
    },
  });
  return fragment === undefined
    ? undefined
    : {
        ...fragment,
        remoteOrigin: {
          kind: "git",
          identity: parsed.sourceId.slice(0, -(parsed.path.length + 1)),
          acquisitionSource: parsed.cloneUrl,
          resolved: fragment.resolved ?? "",
          snapshotRoot: fragment.snapshotRoot,
          key: fragment.key,
        },
      };
};

export const fetchNpm = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
  signal: AbortSignal,
): Promise<FragmentResult | undefined> => {
  const parsed = parseNpmInclude(entry);
  const session = await requiredSourceSession(ctx, signal);
  const fragment = await readPinnedFragment(entry, ctx, {
    sourceId: parsed.sourceId,
    version: parsed.requestedVersion,
    cacheKind: "npm",
    fragmentRelPath: parsed.path,
    openCached: (version) => runSource(session.lookupNpm({ name: parsed.packageName, version }), signal),
    acquire: async (resolved, options) => {
      const selector = resolved ?? parsed.requestedVersion;
      const snapshot = await runSource(
        session.acquireNpm(
          {
            name: parsed.packageName,
            ...(selector === undefined ? {} : { selector }),
          },
          { repair: options.repair },
        ),
        signal,
      );
      if (snapshot.pin.kind === "npm" && !RESOLVED_FORMAT.npm.pattern.test(snapshot.pin.version)) {
        throw includeError({
          message: `npm include ${entry.source} resolved to an invalid version: ${snapshot.pin.version}.`,
          source: entry.source,
          kind: "fetch-failed",
        });
      }
      return snapshot;
    },
  });
  return fragment === undefined
    ? undefined
    : {
        ...fragment,
        remoteOrigin: {
          kind: "npm",
          identity: `npm:${parsed.packageName}`,
          acquisitionSource: parsed.packageName,
          resolved: fragment.resolved ?? "",
          snapshotRoot: fragment.snapshotRoot,
          key: fragment.key,
        },
      };
};
