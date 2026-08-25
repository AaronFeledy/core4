export const INIT_FILE_KINDS = ["landofile", "scaffold"] as const;
export type InitFileKind = (typeof INIT_FILE_KINDS)[number];

const LANDOFILE_DEST = /^\.lando(\.[a-z]+)?\.(ya?ml|ts)$/;

export const initFileKind = (dest: string): InitFileKind => {
  const base = dest.replaceAll("\\", "/").split("/").pop() ?? dest;
  return LANDOFILE_DEST.test(base) ? "landofile" : "scaffold";
};

export interface InitWritePlan {
  readonly write: ReadonlyArray<string>;
  readonly skippedScaffold: ReadonlyArray<string>;
  readonly landofileConflict: string | undefined;
}

export const planInitWrites = (
  dests: ReadonlyArray<string>,
  existing: ReadonlySet<string>,
): InitWritePlan => {
  const landofileConflict = dests.find((dest) => initFileKind(dest) === "landofile" && existing.has(dest));
  if (landofileConflict !== undefined) {
    return { write: [], skippedScaffold: [], landofileConflict };
  }
  const scaffold = dests.filter((dest) => initFileKind(dest) === "scaffold");
  if (scaffold.some((dest) => existing.has(dest))) {
    return {
      write: dests.filter((dest) => initFileKind(dest) === "landofile"),
      skippedScaffold: scaffold,
      landofileConflict: undefined,
    };
  }
  return { write: dests, skippedScaffold: [], landofileConflict: undefined };
};
