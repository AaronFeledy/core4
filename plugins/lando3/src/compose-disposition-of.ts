import {
  type ComposeDisposition,
  composeDispositionFor,
  composeServiceDispositions,
} from "@lando/sdk/landofile";

/**
 * Disposition of a service matrix path, where a rejected key also answers for every path nested
 * under it. Unknown paths stay unknown.
 */
export const dispositionOf = (path: string): ComposeDisposition | "unknown" =>
  composeDispositionFor(composeServiceDispositions, path)?.disposition ?? "unknown";

export const COMPOSE_KEY_RENAMES: Readonly<Record<string, string>> = {
  working_dir: "workingDirectory",
  env_file: "envFile",
  depends_on: "dependsOn",
};

export const CAPABILITY_FRAGILE_KEYS: ReadonlySet<string> = new Set(["pull_policy", "gpus", "deploy"]);
