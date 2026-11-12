import {
  type ComposeDisposition,
  composeDispositionFor,
  composeServiceDispositions,
} from "@lando/sdk/landofile";

export const dispositionOf = (path: string): ComposeDisposition | "unknown" =>
  composeDispositionFor(composeServiceDispositions, path)?.disposition ?? "unknown";

export const COMPOSE_KEY_RENAMES: Readonly<Record<string, string>> = {
  working_dir: "workingDirectory",
  env_file: "envFile",
  depends_on: "dependsOn",
};

export const CAPABILITY_FRAGILE_KEYS: ReadonlySet<string> = new Set(["gpus", "deploy"]);
