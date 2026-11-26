import { ScratchAppNotFoundError } from "@lando/sdk/errors";
import { Result } from "effect";

const LIST_REMEDIATION = "Run `lando apps:scratch:list` to see currently registered scratch apps.";

const SCRATCH_BASE_MAX_LENGTH = 40 - "scratch-".length - "-000000".length;

/** The `<base>` of a generated `scratch-<base>-<6hex>` id, built from `--name` or the source name. */
export const sanitizeScratchBase = (base: string): string => {
  const cleaned = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, SCRATCH_BASE_MAX_LENGTH)
    .replace(/^-+|-+$/gu, "");
  return cleaned.length === 0 ? "scratch" : cleaned;
};

const idBase = (id: string): string | undefined => /^scratch-(.+)-[0-9a-f]{6}$/u.exec(id)?.[1];

export const scratchAppNotFoundError = (
  reference: string,
  suggestions: ReadonlyArray<string> = [],
): ScratchAppNotFoundError =>
  new ScratchAppNotFoundError({
    message: `Scratch app ${reference} was not found.`,
    id: reference,
    suggestions,
    remediation: LIST_REMEDIATION,
  });

/**
 * Resolves what a user typed to one registered scratch: the exact id, else the scratch whose id
 * was generated from that name. Several scratches started with one name are never guessed between.
 */
export const resolveScratchReference = <A extends { readonly id: string }>(
  entries: ReadonlyArray<A>,
  reference: string,
): Result.Result<A, ScratchAppNotFoundError> => {
  const exact = entries.find((entry) => entry.id === reference);
  if (exact !== undefined) return Result.succeed(exact);
  const base = sanitizeScratchBase(reference);
  const sorted = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  const named = sorted.filter((entry) => idBase(entry.id) === base);
  const [only, ...others] = named;
  if (only !== undefined && others.length === 0) return Result.succeed(only);
  if (only !== undefined) {
    const ids = named.map((entry) => entry.id);
    return Result.fail(
      new ScratchAppNotFoundError({
        message: `${ids.length} scratch apps were started with the name ${reference}.`,
        id: reference,
        suggestions: ids,
        remediation: `Pass one of these scratch ids instead: ${ids.join(", ")}.`,
      }),
    );
  }
  const close = sorted.filter((entry) => {
    const entryBase = idBase(entry.id);
    return (
      entry.id.startsWith(reference) ||
      (entryBase !== undefined && (entryBase.startsWith(base) || base.startsWith(entryBase)))
    );
  });
  return Result.fail(
    scratchAppNotFoundError(
      reference,
      close.map((entry) => entry.id),
    ),
  );
};
