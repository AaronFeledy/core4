import type { ExecutionSiteMatch } from "@lando/sdk/landofile/execution-sites";
import type { ValidationIssuePath } from "@lando/sdk/schema";

const usableName = (candidate: unknown): candidate is string =>
  typeof candidate === "string" &&
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate) &&
  candidate !== "LANDO" &&
  !candidate.startsWith("LANDO_");

export const secretVariableNames = (
  input: { readonly value: string; readonly references: readonly string[] },
  path: ValidationIssuePath,
  site: ExecutionSiteMatch["site"] | undefined,
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const reference of new Set(input.references)) {
    const key =
      typeof path.at(-1) === "number" ? input.value.slice(0, input.value.indexOf("=")) : path.at(-1);
    const candidates = site === "build-arg" ? [key, reference] : [reference];
    let name = candidates.find(
      (candidate): candidate is string => usableName(candidate) && !used.has(candidate),
    );
    if (name === undefined) {
      let index = 1;
      while (used.has(index === 1 ? "SECRET" : `SECRET_${index}`)) index++;
      name = index === 1 ? "SECRET" : `SECRET_${index}`;
    }
    names.set(reference, name);
    used.add(name);
  }
  return names;
};
