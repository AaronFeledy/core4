/**
 * `tarball` recipe source resolver.
 *
 * Downloads through SourceSession.acquireArchive (shared source cache, SHA-256
 * identity), then resolves recipe.yml at the archive root or a monorepo --path.
 *
 * Checksum policy:
 *   - `--checksum=<hash>` supplied → SHA-256 is REQUIRED; mismatch fails before extract.
 *   - no checksum → warn/confirm via onUnverified; decline aborts with checksum-unverified.
 */
import { RecipeSourceError } from "@lando/sdk/errors";
import { type SourceSession, displaySource } from "@lando/source-acquisition";

import type { ResolvedRecipe } from "./source";
import { runSourceSession } from "./source-session";
import { normalizeRecipeSubpath, resolveRecipeManifest } from "./source-support";

export interface ResolveTarballRecipeSourceOptions {
  readonly url: string;
  readonly path?: string;
  readonly checksum?: string;
  readonly sources: SourceSession;
  /** Aborts in-flight acquisition when the caller is cancelled. */
  readonly signal?: AbortSignal;
  /** Emitted once with the computed SHA-256 when no `--checksum` was supplied. */
  readonly onWarn?: (message: string) => void | Promise<void>;
  /**
   * Interactive confirmation for the unverified-checksum case. Returning false
   * aborts. Absent ⇒ warn-only (`--yes`/non-interactive).
   */
  readonly confirmUnverified?: (sha256: string) => Promise<boolean>;
}

export interface ResolvedTarballRecipe extends ResolvedRecipe {
  readonly sha256: string;
}

const sourceError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind:
    | "download-failed"
    | "checksum-mismatch"
    | "checksum-unverified"
    | "extract-failed"
    | "subpath-invalid"
    | "subpath-missing"
    | "cache";
  readonly remediation: string;
}): RecipeSourceError =>
  new RecipeSourceError({
    ...input,
    message: displaySource(input.message),
    source: displaySource(input.source),
    remediation: displaySource(input.remediation),
  });

export const resolveTarballRecipeSource = async (
  options: ResolveTarballRecipeSourceOptions,
): Promise<ResolvedTarballRecipe> => {
  const safeSubpath = normalizeRecipeSubpath(
    options.path,
    { label: "Tarball", container: "extracted archive", noun: "archive" },
    (input) => {
      throw sourceError(input);
    },
  );
  const expectedChecksum = options.checksum?.trim().toLowerCase();
  if (
    expectedChecksum !== undefined &&
    expectedChecksum !== "" &&
    !/^[0-9a-f]{64}$/u.test(expectedChecksum)
  ) {
    throw sourceError({
      message: `--checksum must be a 64-character hex SHA-256 digest: ${options.checksum}`,
      source: options.url,
      kind: "checksum-mismatch",
      remediation: "Pass --checksum=<sha256> as 64 lowercase hex characters.",
    });
  }

  let declined: RecipeSourceError | undefined;
  const snapshot = await runSourceSession(
    options.sources.acquireArchive(
      {
        url: options.url,
        ...(expectedChecksum === undefined || expectedChecksum === "" ? {} : { sha256: expectedChecksum }),
      },
      {
        onUnverified: async (sha256) => {
          await options.onWarn?.(
            `No --checksum supplied for tarball recipe ${displaySource(options.url)}; downloaded SHA-256 is ${sha256}. Pass --checksum=<sha256> to verify the archive on future runs.`,
          );
          if (options.confirmUnverified !== undefined) {
            const confirmed = await options.confirmUnverified(sha256);
            if (!confirmed) {
              declined = sourceError({
                message: `Tarball recipe ${displaySource(options.url)} was not verified (no --checksum) and the prompt was declined.`,
                source: displaySource(options.url),
                kind: "checksum-unverified",
                remediation: "Re-run with --checksum=<sha256> to verify the archive, or accept the prompt.",
              });
              throw declined;
            }
          }
        },
      },
    ),
    "archive",
    options.signal,
  ).catch((cause: unknown) => {
    throw declined ?? cause;
  });

  const sha256 = snapshot.pin.sha256;

  const publishedDir = snapshot.root;
  const { recipeRoot, manifestPath, manifestYaml } = await resolveRecipeManifest({
    publishedDir,
    safeSubpath,
    sourceKind: "tarball",
    source: options.url,
    fail: (input) => {
      throw sourceError(input);
    },
  });

  return {
    id: options.url,
    source: manifestPath,
    manifestYaml,
    root: recipeRoot,
    acquisitionRoot: publishedDir,
    sha256,
    transport: { kind: "archive", digest: sha256 },
  };
};
