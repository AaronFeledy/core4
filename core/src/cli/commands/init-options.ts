import type { ProgressEmitter } from "@lando/sdk/task-progress";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import type { InteractionPrompter } from "../../interaction/prompter";
import type { GitRecipeCloner } from "../../recipes/git-source";
import type { NpmRegistryClient } from "../../recipes/npm-source";
import type { PostInitIO } from "../../recipes/post-init/runtime";
import type { RecipeInitReview } from "../../recipes/prepared-init-types";
import type { ChoicesCommandRunner } from "../../recipes/prompts/index";
import type { RecipeRegistryClient } from "../../recipes/registry-source";
import type { TarballRecipeExtractor, TarballRecipeFetcher } from "../../recipes/tarball-source";
import type { BunSelfSpawner } from "./bun-self-runner";

export interface InitAppOptions {
  readonly signal?: AbortSignal;
  readonly cwd: string;
  readonly full: boolean;
  readonly recipe?: string;
  readonly source?: "git" | "tarball" | "npm" | "registry";
  readonly url?: string;
  readonly ref?: string;
  readonly package?: string;
  readonly id?: string;
  readonly path?: string;
  readonly checksum?: string;
  readonly registryUrl?: string;
  readonly userDataRoot?: string;
  readonly gitRecipeCloner?: GitRecipeCloner;
  readonly tarballRecipeFetcher?: TarballRecipeFetcher;
  readonly tarballRecipeExtractor?: TarballRecipeExtractor;
  readonly npmRegistryClient?: NpmRegistryClient;
  readonly registryClient?: RecipeRegistryClient;
  readonly name?: string;
  readonly answers?: Readonly<Record<string, string>>;
  readonly answersFile?: string;
  readonly yes?: boolean;
  readonly nonInteractive?: boolean;
  readonly interaction?: InteractionPrompter;
  readonly onPrepared?: (
    review: RecipeInitReview,
    context: { readonly interaction: InteractionPrompter; readonly signal?: AbortSignal },
  ) => Promise<void>;
  readonly choicesRunner?: ChoicesCommandRunner;
  readonly postInitCommandRunner?: ChoicesCommandRunner;
  readonly postInitSpawner?: BunSelfSpawner;
  readonly postInitIO?: PostInitIO;
  readonly privateFileAccess: PrivateFileAccess;
  readonly onWarn?: (message: string) => void | Promise<void>;
  readonly events?: ProgressEmitter;
  // Absolute render target; defaults to `<cwd>/<appName>` when omitted.
  readonly destination?: string;
  // Run recipe `postInit:` actions after rendering; defaults to true.
  readonly runPostInit?: boolean;
  // Opt-in: write the Lando agent skill pack after a successful init. Default off.
  readonly agentSkills?: boolean;
}
