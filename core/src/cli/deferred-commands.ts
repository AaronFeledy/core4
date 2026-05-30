/**
 * Per-command deferral plans for canonical Lando command ids that are not
 * implemented yet.
 *
 * Each plan names the release bucket that owns the command, the user-facing
 * contract reference, a short "why deferred" summary, and remediation safe
 * to print to stderr. The single `notImplementedErrorForCommand()` function
 * below is consumed by both the source OCLIF guard and the compiled `$bunfs`
 * dispatcher so the two paths produce identical remediation text for the
 * same command id.
 */
import { NotImplementedError } from "@lando/sdk/errors";

export type DeferredCommandPhase = "Phase 3 Beta" | "Phase 4 RC";

export interface DeferredCommandPlan {
  readonly phase: DeferredCommandPhase;
  readonly specSection: string;
  readonly summary: string;
  readonly remediation: string;
}

const APP_INCLUDES_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/07-landofile-and-config.md",
  summary:
    "Landofile `includes:` resolution and the `.lando.lock.yml` workflow are Phase 3 Beta deliverables (spec §7.7).",
  remediation:
    'Landofile `includes:` lands in Phase 3 Beta. Inline the fragments you would have included into the Landofile until Beta. See spec/ROADMAP.md Phase 3 "full breadth" and spec/07-landofile-and-config.md §7.7.',
};

const APP_CONFIG_TRANSLATE_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/07-landofile-and-config.md",
  summary: "Config translator plugins ship in Phase 3 Beta (spec §7, §14 appendix C).",
  remediation:
    'Config translators land in Phase 3 Beta. Hand-author the Landofile until Beta. See spec/ROADMAP.md Phase 3 "full breadth" and spec/07-landofile-and-config.md.',
};

const APPS_SCRATCH_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/19-scratch-apps.md",
  summary:
    "Scratch apps (forked or recipe-rendered short-lived apps bound to an Effect Scope) ship in Phase 3 Beta (spec §21).",
  remediation:
    'Scratch apps land in Phase 3 Beta. See spec/ROADMAP.md Phase 3 "full breadth" and spec/19-scratch-apps.md.',
};

const META_GLOBAL_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/18-global-app.md",
  summary:
    "The global Lando app and the `globalServices:` plugin-contribution surface ship in Phase 3 Beta (spec §20).",
  remediation:
    'The global app and `meta:global:*` commands land in Phase 3 Beta. See spec/ROADMAP.md Phase 3 "full breadth" and spec/18-global-app.md.',
};

const META_PLUGIN_TRUST_PLAN: DeferredCommandPlan = {
  phase: "Phase 4 RC",
  specSection: "spec/10-plugins.md",
  summary:
    'Persistent plugin trust is the Phase 4 RC "Plugin trust UX" open decision (spec/ROADMAP.md §14.2); the command surface ships in RC.',
  remediation:
    '`meta:plugin:trust*` is the "Plugin trust UX" open decision (spec/ROADMAP.md §14.2) and lands in Phase 4 RC. Alpha trust is in-memory per process; pass `--trust` to `lando plugin:add` to authorize a single install. See spec/ROADMAP.md Phase 4 "hardening + governance" and spec/10-plugins.md.',
};

const META_PLUGIN_AUTHORING_PLAN: DeferredCommandPlan = {
  phase: "Phase 4 RC",
  specSection: "spec/10-plugins.md",
  summary:
    "The plugin authoring toolkit (`new`/`test`/`build`/`link`/`unlink`/`publish`) ships in Phase 4 RC (spec §9.10).",
  remediation:
    'Plugin authoring commands (`meta:plugin:{new,test,build,link,unlink,publish}`) land in Phase 4 RC. Author plugins by hand against `@lando/sdk` until RC. See spec/ROADMAP.md Phase 4 "hardening + governance" and spec/10-plugins.md.',
};

const META_PLUGIN_LOGIN_PLAN: DeferredCommandPlan = {
  phase: "Phase 4 RC",
  specSection: "spec/10-plugins.md",
  summary:
    "Plugin registry login/logout pair with `meta:plugin:publish` and ship in Phase 4 RC (spec §9.10).",
  remediation:
    'Plugin registry login/logout land in Phase 4 RC alongside `meta:plugin:publish`. See spec/ROADMAP.md Phase 4 "hardening + governance" and spec/10-plugins.md.',
};

const META_RECIPES_LIST_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/08-cli-and-tooling.md",
  summary:
    "Recipe catalog listing through `meta:recipes:list` ships in Phase 3 Beta alongside the full canonical recipe set.",
  remediation:
    '`meta:recipes:list` lands in Phase 3 Beta. Phase 2 Alpha ships its bundled recipes as `--recipe <id>` arguments to `lando init`; run `lando init --help` for the current alpha set. See spec/ROADMAP.md Phase 3 "full breadth" and spec/08-cli-and-tooling.md.',
};

const META_EVENTS_FOLLOW_PLAN: DeferredCommandPlan = {
  phase: "Phase 3 Beta",
  specSection: "spec/08-cli-and-tooling.md",
  summary: "Lifecycle-event streaming through `meta:events:follow` ships in Phase 3 Beta (spec §3.5, §8.2).",
  remediation:
    '`meta:events:follow` lands in Phase 3 Beta. Use `--renderer=json` on a specific command in Phase 2 Alpha to observe its event stream. See spec/ROADMAP.md Phase 3 "full breadth" and spec/08-cli-and-tooling.md.',
};

const META_UNINSTALL_PLAN: DeferredCommandPlan = {
  phase: "Phase 4 RC",
  specSection: "spec/15-binary-build-and-release.md",
  summary: "`lando uninstall` is part of the Phase 4 RC binary acceptance criteria (spec §17.9 / spec/15).",
  remediation:
    '`meta:uninstall` lands in Phase 4 RC alongside the signed/notarized binary. Remove the Phase 2 Alpha install by deleting the `lando` binary and `<userDataRoot>`/`<userCacheRoot>` by hand. See spec/ROADMAP.md Phase 4 "hardening + governance" and spec/15-binary-build-and-release.md.',
};

const META_UPDATE_PLAN: DeferredCommandPlan = {
  phase: "Phase 4 RC",
  specSection: "spec/15-binary-build-and-release.md",
  summary: "Self-update (`meta:update`) is part of the Phase 4 RC binary acceptance criteria (spec §17.6).",
  remediation:
    '`meta:update` lands in Phase 4 RC together with signing, notarization, and the update manifest. Re-download the Phase 2 Alpha binary by hand. See spec/ROADMAP.md Phase 4 "hardening + governance" and spec/15-binary-build-and-release.md.',
};

export const DEFERRED_COMMAND_PLANS: ReadonlyMap<string, DeferredCommandPlan> = new Map<
  string,
  DeferredCommandPlan
>([
  ["app:includes:update", APP_INCLUDES_PLAN],
  ["app:includes:verify", APP_INCLUDES_PLAN],
  ["app:config:translate", APP_CONFIG_TRANSLATE_PLAN],
  ["apps:scratch:destroy", APPS_SCRATCH_PLAN],
  ["apps:scratch:gc", APPS_SCRATCH_PLAN],
  ["apps:scratch:info", APPS_SCRATCH_PLAN],
  ["apps:scratch:list", APPS_SCRATCH_PLAN],
  ["apps:scratch:logs", APPS_SCRATCH_PLAN],
  ["apps:scratch:start", APPS_SCRATCH_PLAN],
  ["apps:scratch:stop", APPS_SCRATCH_PLAN],
  ["meta:global:config", META_GLOBAL_PLAN],
  ["meta:global:destroy", META_GLOBAL_PLAN],
  ["meta:global:info", META_GLOBAL_PLAN],
  ["meta:global:list", META_GLOBAL_PLAN],
  ["meta:global:logs", META_GLOBAL_PLAN],
  ["meta:global:rebuild", META_GLOBAL_PLAN],
  ["meta:global:restart", META_GLOBAL_PLAN],
  ["meta:global:start", META_GLOBAL_PLAN],
  ["meta:global:stop", META_GLOBAL_PLAN],
  ["meta:global:uninstall", META_GLOBAL_PLAN],
  ["meta:plugin:trust", META_PLUGIN_TRUST_PLAN],
  ["meta:plugin:trust-authoring-root", META_PLUGIN_TRUST_PLAN],
  ["meta:plugin:new", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:test", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:build", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:link", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:unlink", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:publish", META_PLUGIN_AUTHORING_PLAN],
  ["meta:plugin:login", META_PLUGIN_LOGIN_PLAN],
  ["meta:plugin:logout", META_PLUGIN_LOGIN_PLAN],
  ["meta:recipes:list", META_RECIPES_LIST_PLAN],
  ["meta:events:follow", META_EVENTS_FOLLOW_PLAN],
  ["meta:uninstall", META_UNINSTALL_PLAN],
  ["meta:update", META_UPDATE_PLAN],
]);

export const deferredCommandPlan = (commandId: string): DeferredCommandPlan | undefined =>
  DEFERRED_COMMAND_PLANS.get(commandId);

export const allDeferredCommandIds = (): ReadonlyArray<string> =>
  Array.from(DEFERRED_COMMAND_PLANS.keys()).sort((left, right) => left.localeCompare(right));

/**
 * Build the deferred-command `NotImplementedError` for a command id.
 */
export const notImplementedErrorForCommand = (commandId: string): NotImplementedError => {
  const plan = DEFERRED_COMMAND_PLANS.get(commandId);
  if (plan !== undefined) {
    return new NotImplementedError({
      message: `Command ${commandId} is not implemented in Phase 2 Alpha. ${plan.summary}`,
      commandId,
      specSection: plan.specSection,
      remediation: plan.remediation,
    });
  }
  // Fallback for unknown canonical command ids.
  const specSection = "spec/08-cli-and-tooling.md";
  return new NotImplementedError({
    message: `Command ${commandId} is not implemented in Phase 2 Alpha.`,
    commandId,
    specSection,
    remediation: `See spec/ROADMAP.md for the target release phase and ${specSection} for the command's owning specification.`,
  });
};
