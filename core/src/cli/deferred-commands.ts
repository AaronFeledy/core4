/**
 * Per-command deferral plans for canonical Lando command ids.
 *
 * The single `notImplementedErrorForCommand()` function is consumed by both
 * the source OCLIF guard and the compiled `$bunfs` dispatcher so the two paths
 * produce identical remediation text for the same command id.
 */
import { NotImplementedError } from "@lando/sdk/errors";

export interface DeferredCommandPlan {
  readonly summary: string;
  readonly remediation: string;
}

const META_GLOBAL_PLAN: DeferredCommandPlan = {
  summary:
    "The global Lando app and the `globalServices:` plugin-contribution surface are not available yet.",
  remediation: "The global app and `meta:global:*` commands are not available yet.",
};

const META_PLUGIN_LOGIN_PLAN: DeferredCommandPlan = {
  summary: "Plugin registry login/logout are not available yet.",
  remediation: "Plugin registry login/logout are not available yet.",
};

const META_RECIPES_LIST_PLAN: DeferredCommandPlan = {
  summary: "Recipe catalog listing through `meta:recipes:list` is not available yet.",
  remediation:
    "`meta:recipes:list` is not available yet. Use `lando init --help` to list currently bundled recipes available through `lando init --recipe <id>`.",
};

const META_EVENTS_FOLLOW_PLAN: DeferredCommandPlan = {
  summary: "Lifecycle-event streaming through `meta:events:follow` is not available yet.",
  remediation:
    "`meta:events:follow` is not available yet. Use `--renderer=json` on a specific command to observe its event stream.",
};

export const DEFERRED_COMMAND_PLANS: ReadonlyMap<string, DeferredCommandPlan> = new Map<
  string,
  DeferredCommandPlan
>([
  ["meta:global:info", META_GLOBAL_PLAN],
  ["meta:global:list", META_GLOBAL_PLAN],
  ["meta:global:logs", META_GLOBAL_PLAN],
  ["meta:global:rebuild", META_GLOBAL_PLAN],
  ["meta:global:restart", META_GLOBAL_PLAN],
  ["meta:plugin:login", META_PLUGIN_LOGIN_PLAN],
  ["meta:plugin:logout", META_PLUGIN_LOGIN_PLAN],
  ["meta:recipes:list", META_RECIPES_LIST_PLAN],
  ["meta:events:follow", META_EVENTS_FOLLOW_PLAN],
]);

export const deferredCommandPlan = (commandId: string): DeferredCommandPlan | undefined =>
  DEFERRED_COMMAND_PLANS.get(commandId);

export const allDeferredCommandIds = (): ReadonlyArray<string> =>
  Array.from(DEFERRED_COMMAND_PLANS.keys()).sort((left, right) => left.localeCompare(right));

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError => {
  const plan = DEFERRED_COMMAND_PLANS.get(commandId);
  if (plan !== undefined) {
    return new NotImplementedError({
      message: `Command ${commandId} is not implemented. ${plan.summary}`,
      commandId,
      remediation: plan.remediation,
    });
  }
  // Fallback for unknown canonical command ids.
  return new NotImplementedError({
    message: `Command ${commandId} is not implemented.`,
    commandId,
    remediation: "This command is not available yet. Run `lando --help` to see currently available commands.",
  });
};
