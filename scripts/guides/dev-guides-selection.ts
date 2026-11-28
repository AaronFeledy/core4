export interface DevGuidesOptions {
  readonly once: boolean;
  /** Zero paths runs every guide; several paths are accepted only with `--once`. */
  readonly guidePaths: readonly string[];
}

export interface AffectedGuidesContext {
  readonly allGuideIds: readonly string[];
  readonly guidePathToId: ReadonlyMap<string, string>;
  readonly singleGuideId?: string;
}

export const normalize = (path: string): string => path.replaceAll("\\", "/");

export const uniqueSorted = (ids: readonly string[]): readonly string[] =>
  [...new Set(ids)].sort((left, right) => left.localeCompare(right));

export const parseDevGuidesArgs = (args: ReadonlyArray<string>): DevGuidesOptions => {
  let once = false;
  const guidePaths: string[] = [];
  for (const arg of args) {
    if (arg === "--once") {
      once = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown dev:guides flag: ${arg}`);
    guidePaths.push(normalize(arg));
  }
  if (guidePaths.length > 1 && !once)
    throw new Error("dev:guides accepts several guide paths only with --once");
  return { once, guidePaths };
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
