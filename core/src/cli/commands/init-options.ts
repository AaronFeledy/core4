import type { ProgressEmitter } from "@lando/sdk/task-progress";
import type { SourceSession, SourceStore } from "@lando/source-acquisition";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import type { InteractionPrompter } from "../../interaction/prompter";
import type { PostInitIO } from "../../recipes/post-init/runtime";
import type { RecipeInitReview } from "../../recipes/prepared-init-types";
import type { ChoicesCommandRunner } from "../../recipes/prompts/index";
import type { RecipeRegistryClient } from "../../recipes/registry-source";

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
  /**
   * Caller-owned session kept open through acquisition, preparation, and
   * publication. Otherwise initApp opens a session from recipeSourceStore.
   */
  readonly sources?: SourceSession;
  /**
   * Used when `sources` is omitted; defaults to the retained runtime store.
   */
  readonly recipeSourceStore?: SourceStore;
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
  readonly userDataRoot?: string;
}
