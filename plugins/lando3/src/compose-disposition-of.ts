import { type ComposeDisposition, composeServiceDispositions } from "@lando/sdk/landofile";

/** Exact-key projection of the SDK service disposition matrix. Unknown paths stay unknown. */
export const dispositionOf = (path: string): ComposeDisposition | "unknown" => {
  if (!Object.hasOwn(composeServiceDispositions, path)) return "unknown";
  const entry = composeServiceDispositions[path];
  return entry === undefined ? "unknown" : entry.disposition;
};

export const COMPOSE_KEY_RENAMES: Readonly<Record<string, string>> = {
  working_dir: "workingDirectory",
  env_file: "envFile",
  depends_on: "dependsOn",
};

export const CAPABILITY_FRAGILE_KEYS: ReadonlySet<string> = new Set(["pull_policy", "gpus", "deploy"]);
