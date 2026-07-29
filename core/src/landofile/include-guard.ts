import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { LandofileIncludeError } from "@lando/sdk/errors";

export const INCLUDE_REMEDIATION =
  "Check the includes: entry and retry after the referenced Landofile fragment is available.";

/**
 * Include messages interpolate authored sources, fragment keys, and namespaces,
 * and reach the plain terminal renderer unchanged. A repo-authored control byte
 * could otherwise rewrite or spoof terminal output, so strip them once here
 * rather than at every interpolation site.
 */
const withoutControlBytes = (value: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point
  value.replace(/[\u0000-\u001f\u007f]/gu, "");

export const includeError = (input: {
  readonly message: string;
  readonly source: string;
  readonly kind: LandofileIncludeError["kind"];
  readonly remediation?: string;
}): LandofileIncludeError =>
  new LandofileIncludeError({
    message: withoutControlBytes(input.message),
    source: withoutControlBytes(input.source),
    kind: input.kind,
    remediation: withoutControlBytes(input.remediation ?? INCLUDE_REMEDIATION),
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
