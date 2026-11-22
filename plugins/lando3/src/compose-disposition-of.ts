import {
  type ComposeDisposition,
  composeDispositionFor,
  composeServiceDispositions,
} from "@lando/sdk/landofile";

export const dispositionOf = (path: string): ComposeDisposition | "unknown" =>
  composeDispositionFor(composeServiceDispositions, path)?.disposition ?? "unknown";

export const CAPABILITY_FRAGILE_KEYS: ReadonlySet<string> = new Set(["gpus", "deploy"]);
