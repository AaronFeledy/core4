import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { LandofileIncludeError } from "@lando/sdk/errors";

export const INCLUDE_REMEDIATION =
  "Check the includes: entry and retry after the referenced Landofile fragment is available.";

export const includeError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: LandofileIncludeError["kind"];
  readonly remediation?: string;
}): LandofileIncludeError =>
  new LandofileIncludeError({
    message: input.message,
    source: input.source,
    kind: input.kind,
    remediation: input.remediation ?? INCLUDE_REMEDIATION,
  });

export const realpathOrSelf = (path: string): Promise<string> => realpath(path).catch(() => path);

export const assertUnderRoot = async (
  root: string,
  path: string,
  source: string,
  rootLabel = "app root",
): Promise<string> => {
  const rootReal = await realpathOrSelf(root);
  const pathReal = await realpathOrSelf(path);
  const rel = relative(rootReal, pathReal);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw includeError({
      message: `Include ${source} resolves outside the ${rootLabel}.`,
      source,
      kind: "outside-root",
      remediation: `Use an include path that stays inside the ${rootLabel}.`,
    });
  }
  return pathReal;
};
