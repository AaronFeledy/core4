import { basename } from "node:path";
import type { ServiceTypeProjectFileInput } from "@lando/sdk/services";
import { major } from "semver";
import { NodeInferenceError } from "./node-inference.ts";
import type { NodePackageManagerSelection } from "./node-package-manager.ts";

export const YARN_RC = ".yarnrc.yml";

const readLinker = (file: ServiceTypeProjectFileInput & { readonly present: true }): string | undefined => {
  let config: unknown;
  try {
    config = Bun.YAML.parse(file.text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    throw new NodeInferenceError("Expected valid YAML.", "Fix the YAML syntax.", file.path, ["nodeLinker"]);
  }
  // The parser returns null for an empty or comment-only document.
  if (config === null) return undefined;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new NodeInferenceError(
      "Expected a YAML mapping.",
      "Put nodeLinker in a top-level mapping.",
      file.path,
      ["nodeLinker"],
    );
  }
  if (!Object.hasOwn(config, "nodeLinker")) return undefined;
  const linker: unknown = Reflect.get(config, "nodeLinker");
  if (typeof linker !== "string") {
    throw new NodeInferenceError(
      "Expected nodeLinker to be a string.",
      'Use "pnp", "node-modules", or "pnpm", or remove nodeLinker for the default.',
      file.path,
      ["nodeLinker"],
    );
  }
  return linker;
};

export const usesYarnPnp = (
  manager: NodePackageManagerSelection | undefined,
  files: ReadonlyArray<ServiceTypeProjectFileInput>,
): boolean => {
  if (manager?.name !== "yarn" || major(manager.version) < 2) return false;
  // The planner provides only the declared rc files. A nested key wins over
  // the app root, but both files still have to be valid.
  let nested: string | undefined;
  let root: string | undefined;
  for (const file of files) {
    if (!file.present || basename(file.path) !== YARN_RC) continue;
    if (file.path === YARN_RC) root = readLinker(file);
    else nested = readLinker(file);
  }
  return (nested ?? root ?? "pnp") === "pnp";
};
