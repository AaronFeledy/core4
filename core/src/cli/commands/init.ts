import { join } from "node:path";

import { Effect } from "effect";

import { InitTargetExistsError } from "@lando/sdk/errors";
import { makeTaskTree } from "@lando/sdk/task-progress";

import { resolveUserDataRoot } from "@lando/engine/config/roots";
import {
  RecipeInitCommitError,
  type RecipeInitReceipt,
  runRecipeInitPipeline,
} from "../../recipes/init-pipeline";
import { type PostInitOutcome, runPostInit } from "../../recipes/post-init/runtime";
import type { RecipeInitPreview } from "../../recipes/prepared-init";
import type { PromptAnswers } from "../../recipes/prompts/index";
import { type AgentSkillsResult, installAgentSkills } from "./agent-skills";
import type { InitAppOptions } from "./init-options";
import { prepareInitApp } from "./init-preparation";

export type { InitAppOptions } from "./init-options";
export { stripSecretInitAnswers } from "./init-preparation";

export interface InitAppResult {
  readonly appName: string;
  readonly directory: string;
  /** Collected nonsecret answers only. Secret prompt values are never returned. */
  readonly answers: PromptAnswers;
  readonly postInit: PostInitOutcome;
  readonly skippedScaffold: ReadonlyArray<string>;
  readonly preview: RecipeInitPreview;
  readonly receipt: RecipeInitReceipt;
  readonly agentSkills?: AgentSkillsResult;
}

export const initApp = async (options: InitAppOptions): Promise<InitAppResult> => {
  const { prepared, manifest, directory, publicAnswers, appName } = await prepareInitApp(options);

  const filesToWrite = prepared.outputs;
  const postInitActions = prepared.actions;

  const shouldRunPostInit = options.runPostInit !== false && postInitActions.length > 0;
  const initParentId = `init:${manifest.id}`;
  const tree = makeTaskTree(options.events, {
    parentId: initParentId,
    label: `Initialize ${appName}`,
    children: [
      { id: "render", label: `Render recipe files (${filesToWrite.length})` },
      ...(shouldRunPostInit
        ? [{ id: "postinit", label: `Run post-init actions (${postInitActions.length})` }]
        : []),
      ...(options.agentSkills === true ? [{ id: "agentskills", label: "Install agent skills" }] : []),
    ],
    mode: "list",
  });

  await Effect.runPromise(tree.start);
  await Effect.runPromise(tree.startTask("render"));

  let postInit: PostInitOutcome = { executed: [] };
  const skippedScaffold = prepared.skippedScaffold;
  let receipt: RecipeInitReceipt;
  let postInitStarted = false;

  try {
    if (prepared.conflicts[0] !== undefined) {
      const conflictPath = join(directory, prepared.conflicts[0]);
      await Effect.runPromise(
        tree.failTask("render", `Init target already has a Landofile: ${conflictPath}`),
      );
      await Effect.runPromise(tree.close("Initialization aborted"));
      throw new InitTargetExistsError({
        message: `Init target already has a Landofile: ${conflictPath}`,
        path: conflictPath,
        remediation: "Remove the existing Landofile or choose a different directory.",
      });
    }

    if (options.privateFileAccess === undefined) {
      throw new RecipeInitCommitError({
        message: "Private file access is unavailable for recipe initialization.",
        remediation: "Run initialization through the Lando runtime.",
        phase: "prepare",
        reason: "private-file-access-unavailable",
      });
    }
    const result = await Effect.runPromise(
      runRecipeInitPipeline({
        prepared,
        postInitEnabled: options.runPostInit !== false,
        journalRoot: () => options.userDataRoot ?? resolveUserDataRoot(),
        privateFileAccess: options.privateFileAccess,
        runPostInit: async (bound) => {
          if (!shouldRunPostInit) {
            return { executed: [] };
          }
          if (!postInitStarted) {
            await Effect.runPromise(
              tree.completeTask(
                "render",
                `Rendered ${filesToWrite.length} ${filesToWrite.length === 1 ? "file" : "files"}`,
              ),
            );
            await Effect.runPromise(tree.startTask("postinit"));
            postInitStarted = true;
          }
          return runPostInit({
            ...bound,
            ...(options.postInitIO === undefined ? {} : { io: options.postInitIO }),
            ...(options.postInitSpawner === undefined ? {} : { spawner: options.postInitSpawner }),
            ...(options.postInitCommandRunner === undefined
              ? {}
              : { commandRunner: options.postInitCommandRunner }),
          });
        },
      }),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    postInit = result.postInit;
    receipt = result.receipt;
  } catch (cause) {
    if (cause instanceof InitTargetExistsError) throw cause;

    await Effect.runPromise(
      tree.failTask(
        postInitStarted ? "postinit" : "render",
        postInitStarted ? "Post-init failed" : "Render failed",
      ),
    );
    await Effect.runPromise(tree.close("Initialization failed"));
    throw cause;
  }

  if (postInitStarted) {
    await Effect.runPromise(
      tree.completeTask(
        "postinit",
        `Ran ${postInit.executed.length} ${postInit.executed.length === 1 ? "action" : "actions"}`,
      ),
    );
  } else {
    await Effect.runPromise(
      tree.completeTask(
        "render",
        `Rendered ${filesToWrite.length} ${filesToWrite.length === 1 ? "file" : "files"}`,
      ),
    );
  }

  if (options.agentSkills !== true) {
    await Effect.runPromise(tree.close(`Initialized ${appName}`));
    return {
      appName,
      directory,
      answers: publicAnswers,
      postInit,
      skippedScaffold,
      preview: prepared.preview,
      receipt,
    };
  }

  await Effect.runPromise(tree.startTask("agentskills"));
  let agentSkills: AgentSkillsResult;
  try {
    agentSkills = await Effect.runPromise(
      installAgentSkills({ appRoot: directory }),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (cause) {
    await Effect.runPromise(tree.failTask("agentskills", "Agent skill installation failed"));
    await Effect.runPromise(tree.close("Initialization failed"));
    throw cause;
  }
  await Effect.runPromise(tree.completeTask("agentskills", "Installed agent skills"));
  await Effect.runPromise(tree.close(`Initialized ${appName}`));
  return {
    appName,
    directory,
    answers: publicAnswers,
    postInit,
    skippedScaffold,
    agentSkills,
    preview: prepared.preview,
    receipt,
  };
};
