import { join } from "node:path";

import type { ProcessRunner } from "@lando/sdk/services";
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

export const initApp = Effect.fn("InitApp.run")(function* (options: InitAppOptions) {
  const context = yield* Effect.context<ProcessRunner>();
  let pending: Promise<InitAppResult> | undefined;
  return yield* Effect.tryPromise({
    try: (signal) => {
      const bound = Effect.runPromiseWith(context);
      const run: ReturnType<typeof Effect.runPromiseWith<ProcessRunner>> = (effect, runOptions) =>
        bound(effect, {
          ...runOptions,
          signal: runOptions?.signal === undefined ? signal : AbortSignal.any([signal, runOptions.signal]),
        });
      pending = initAppInContext({ ...options, signal: options.signal ?? signal }, run);
      return pending;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.onInterrupt(() =>
      Effect.promise(async () => {
        if (pending !== undefined) await Promise.allSettled([pending]);
      }),
    ),
  );
});

const initAppInContext = async (
  options: InitAppOptions,
  run: ReturnType<typeof Effect.runPromiseWith<ProcessRunner>>,
): Promise<InitAppResult> => {
  options.signal?.throwIfAborted();
  const { prepared, manifest, directory, publicAnswers, appName, interaction, reviewEligible } =
    await prepareInitApp(options);

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

  let postInit: PostInitOutcome = { executed: [] };
  const skippedScaffold = prepared.skippedScaffold;
  let receipt: RecipeInitReceipt;
  let postInitStarted = false;
  let renderStarted = false;

  try {
    if (prepared.conflicts[0] !== undefined) {
      const conflictPath = join(directory, prepared.conflicts[0]);
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
    const result = await run(
      runRecipeInitPipeline(
        {
          prepared,
          postInitEnabled: options.runPostInit !== false,
          journalRoot: () => options.userDataRoot ?? resolveUserDataRoot(),
          privateFileAccess: options.privateFileAccess,
          runPostInit: async (bound) => {
            if (!shouldRunPostInit) {
              return { executed: [] };
            }
            if (!postInitStarted) {
              await run(
                tree.completeTask(
                  "render",
                  `Rendered ${filesToWrite.length} ${filesToWrite.length === 1 ? "file" : "files"}`,
                ),
              );
              await run(tree.startTask("postinit"));
              postInitStarted = true;
            }
            return runPostInit({
              ...bound,
              ...(options.postInitIO === undefined ? {} : { io: options.postInitIO }),
              ...(options.postInitCommandRunner === undefined
                ? {}
                : { commandRunner: options.postInitCommandRunner }),
            });
          },
        },
        (review) =>
          Effect.gen(function* () {
            const onPrepared = options.onPrepared;
            if (reviewEligible && onPrepared !== undefined) {
              yield* Effect.tryPromise({
                try: async (signal) => {
                  const sharedSignal = options.signal ?? signal;
                  sharedSignal.throwIfAborted();
                  await onPrepared(review, { interaction, signal: sharedSignal });
                  sharedSignal.throwIfAborted();
                },
                catch: (cause) => cause,
              });
            }
            yield* tree.start;
            renderStarted = true;
            yield* tree.startTask("render");
          }),
      ),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
    postInit = result.postInit;
    receipt = result.receipt;
  } catch (cause) {
    if (!renderStarted) throw cause;

    await run(
      tree.failTask(
        postInitStarted ? "postinit" : "render",
        postInitStarted ? "Post-init failed" : "Render failed",
      ),
    );
    await run(tree.close("Initialization failed"));
    throw cause;
  }

  if (postInitStarted) {
    await run(
      tree.completeTask(
        "postinit",
        `Ran ${postInit.executed.length} ${postInit.executed.length === 1 ? "action" : "actions"}`,
      ),
    );
  } else {
    await run(
      tree.completeTask(
        "render",
        `Rendered ${filesToWrite.length} ${filesToWrite.length === 1 ? "file" : "files"}`,
      ),
    );
  }

  if (options.agentSkills !== true) {
    await run(tree.close(`Initialized ${appName}`));
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

  await run(tree.startTask("agentskills"));
  let agentSkills: AgentSkillsResult;
  try {
    agentSkills = await run(
      installAgentSkills({ appRoot: directory }),
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (cause) {
    await run(tree.failTask("agentskills", "Agent skill installation failed"));
    await run(tree.close("Initialization failed"));
    throw cause;
  }
  await run(tree.completeTask("agentskills", "Installed agent skills"));
  await run(tree.close(`Initialized ${appName}`));
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
