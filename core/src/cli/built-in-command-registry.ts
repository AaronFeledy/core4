import { NotImplementedError } from "@lando/sdk/errors";

import { buildBuiltInCommandIndex } from "./built-in-command-index";
import { appCacheRefreshSpec } from "./command-specs/app/cache/refresh";
import { appConfigSpec } from "./command-specs/app/config";
import { appConfigLintSpec } from "./command-specs/app/config/lint";
import { appConfigTranslateSpec } from "./command-specs/app/config/translate";
import {
  appConfigEditSpec,
  appConfigSetSpec,
  appConfigUnsetSpec,
  appConfigValidateSpec,
} from "./command-specs/app/config/verbs";
import { destroySpec } from "./command-specs/app/destroy";
import { execSpec } from "./command-specs/app/exec";
import { appIncludesUpdateSpec } from "./command-specs/app/includes/update";
import { appIncludesVerifySpec } from "./command-specs/app/includes/verify";
import { infoSpec } from "./command-specs/app/info";
import { logsSpec } from "./command-specs/app/logs";
import { openSpec } from "./command-specs/app/open";
import { pullSpec } from "./command-specs/app/pull";
import { pushSpec } from "./command-specs/app/push";
import { rebuildSpec } from "./command-specs/app/rebuild";
import { remoteAddSpec } from "./command-specs/app/remote/add";
import { remoteEnvListSpec } from "./command-specs/app/remote/env/list";
import { remoteListSpec } from "./command-specs/app/remote/list";
import { remoteRemoveSpec } from "./command-specs/app/remote/remove";
import { remoteSetupSpec } from "./command-specs/app/remote/setup";
import { remoteTestSpec } from "./command-specs/app/remote/test";
import { restartSpec } from "./command-specs/app/restart";
import { shareSpec } from "./command-specs/app/share";
import { shareListSpec } from "./command-specs/app/share/list";
import { shareStopSpec } from "./command-specs/app/share/stop";
import { appShellSpec } from "./command-specs/app/shell";
import { sshSpec } from "./command-specs/app/ssh";
import { startSpec } from "./command-specs/app/start";
import { stopSpec } from "./command-specs/app/stop";
import { initSpec } from "./command-specs/apps/init";
import { listSpec } from "./command-specs/apps/list";
import { poweroffSpec } from "./command-specs/apps/poweroff";
import { appsScratchDestroySpec } from "./command-specs/apps/scratch/destroy";
import { appsScratchGcSpec } from "./command-specs/apps/scratch/gc";
import { appsScratchInfoSpec } from "./command-specs/apps/scratch/info";
import { appsScratchListSpec } from "./command-specs/apps/scratch/list";
import { appsScratchLogsSpec } from "./command-specs/apps/scratch/logs";
import { appsScratchRunSpec } from "./command-specs/apps/scratch/run";
import { appsScratchStartSpec } from "./command-specs/apps/scratch/start";
import { appsScratchStopSpec } from "./command-specs/apps/scratch/stop";
import { metaBunSpec } from "./command-specs/meta/bun";
import { metaConfigSpec } from "./command-specs/meta/config";
import { metaDoctorSpec } from "./command-specs/meta/doctor";
import { metaEventsFollowSpec } from "./command-specs/meta/events/follow";
import { metaGlobalConfigSpec } from "./command-specs/meta/global/config";
import {
  metaGlobalConfigEditSpec,
  metaGlobalConfigSetSpec,
  metaGlobalConfigUnsetSpec,
  metaGlobalConfigValidateSpec,
} from "./command-specs/meta/global/config-verbs";
import { metaGlobalDestroySpec } from "./command-specs/meta/global/destroy";
import { metaGlobalInfoSpec } from "./command-specs/meta/global/info";
import { metaGlobalInstallSpec } from "./command-specs/meta/global/install";
import { metaGlobalListSpec } from "./command-specs/meta/global/list";
import { globalLogsSpec } from "./command-specs/meta/global/logs";
import { metaGlobalRebuildSpec } from "./command-specs/meta/global/rebuild";
import { metaGlobalRestartSpec } from "./command-specs/meta/global/restart";
import { metaGlobalStartSpec } from "./command-specs/meta/global/start";
import { metaGlobalStatusSpec } from "./command-specs/meta/global/status";
import { metaGlobalStopSpec } from "./command-specs/meta/global/stop";
import { metaGlobalUninstallSpec } from "./command-specs/meta/global/uninstall";
import { metaMcpSpec } from "./command-specs/meta/mcp";
import { pluginAddSpec } from "./command-specs/meta/plugin/add";
import { pluginBuildSpec } from "./command-specs/meta/plugin/build";
import { pluginLinkSpec } from "./command-specs/meta/plugin/link";
import { pluginLoginSpec } from "./command-specs/meta/plugin/login";
import { pluginLogoutSpec } from "./command-specs/meta/plugin/logout";
import { pluginNewSpec } from "./command-specs/meta/plugin/new";
import { pluginPublishSpec } from "./command-specs/meta/plugin/publish";
import { pluginRemoveSpec } from "./command-specs/meta/plugin/remove";
import { pluginTestSpec } from "./command-specs/meta/plugin/test";
import { pluginTrustSpec } from "./command-specs/meta/plugin/trust";
import { pluginTrustAuthoringRootSpec } from "./command-specs/meta/plugin/trust-authoring-root";
import { pluginUnlinkSpec } from "./command-specs/meta/plugin/unlink";
import { metaRecipesDescribeSpec } from "./command-specs/meta/recipes/describe";
import { metaRecipesListSpec } from "./command-specs/meta/recipes/list";
import { metaRecipesValidateSpec } from "./command-specs/meta/recipes/validate";
import { setupSpec } from "./command-specs/meta/setup";
import { shellenvSpec } from "./command-specs/meta/shellenv";
import { metaUninstallSpec } from "./command-specs/meta/uninstall";
import { updateSpec } from "./command-specs/meta/update";
import { versionSpec } from "./command-specs/meta/version";
import { metaXSpec } from "./command-specs/meta/x";
import { type DeferredCommandPlan, notImplementedErrorForSpec } from "./deferred-commands";
import type { LandoCommandSpec } from "./spec/command-base";

export { buildBuiltInCommandIndex } from "./built-in-command-index";

export type BuiltInCommandStatus =
  | { readonly kind: "implemented" }
  | { readonly kind: "deferred"; readonly plan: DeferredCommandPlan }
  | {
      readonly kind: "embedding-exempt";
      readonly reason: string;
      readonly remediation: string;
    };

export type BuiltInCommandEntry = {
  readonly spec: LandoCommandSpec;
  readonly status: BuiltInCommandStatus;
};

type EmbeddingExemption = Extract<BuiltInCommandStatus, { readonly kind: "embedding-exempt" }>;
type BuiltInCommandRegistration =
  | LandoCommandSpec
  | { readonly spec: LandoCommandSpec; readonly exemption: EmbeddingExemption };

const embeddingExempt = (
  spec: LandoCommandSpec,
  reason: string,
  remediation: string,
): BuiltInCommandRegistration => ({
  spec,
  exemption: { kind: "embedding-exempt", reason, remediation },
});

const registered = (registration: BuiltInCommandRegistration): BuiltInCommandEntry => {
  const spec = "exemption" in registration ? registration.spec : registration;
  const status: BuiltInCommandStatus =
    "exemption" in registration
      ? registration.exemption
      : spec.deferred === undefined
        ? { kind: "implemented" }
        : { kind: "deferred", plan: spec.deferred };
  return Object.freeze({
    spec,
    status: Object.freeze(status),
  });
};

export const builtInCommandCatalog: Readonly<Record<string, BuiltInCommandEntry>> = Object.freeze(
  Object.fromEntries(
    [
      appCacheRefreshSpec,
      appConfigSpec,
      appConfigLintSpec,
      appConfigTranslateSpec,
      appConfigSetSpec,
      appConfigUnsetSpec,
      appConfigEditSpec,
      appConfigValidateSpec,
      destroySpec,
      execSpec,
      appIncludesUpdateSpec,
      appIncludesVerifySpec,
      infoSpec,
      logsSpec,
      openSpec,
      pullSpec,
      pushSpec,
      remoteAddSpec,
      remoteEnvListSpec,
      remoteListSpec,
      remoteRemoveSpec,
      remoteSetupSpec,
      remoteTestSpec,
      shareSpec,
      shareListSpec,
      shareStopSpec,
      rebuildSpec,
      restartSpec,
      appShellSpec,
      sshSpec,
      startSpec,
      stopSpec,
      embeddingExempt(
        initSpec,
        "App initialization owns host filesystem creation and interactive recipe acquisition outside an existing runtime.",
        "Run `lando init` through the native CLI.",
      ),
      listSpec,
      poweroffSpec,
      appsScratchDestroySpec,
      appsScratchGcSpec,
      appsScratchInfoSpec,
      appsScratchListSpec,
      appsScratchLogsSpec,
      appsScratchRunSpec,
      appsScratchStartSpec,
      appsScratchStopSpec,
      metaBunSpec,
      metaConfigSpec,
      metaDoctorSpec,
      metaEventsFollowSpec,
      metaGlobalConfigSpec,
      metaGlobalConfigSetSpec,
      metaGlobalConfigUnsetSpec,
      metaGlobalConfigEditSpec,
      metaGlobalConfigValidateSpec,
      metaGlobalDestroySpec,
      metaGlobalInfoSpec,
      metaGlobalInstallSpec,
      metaGlobalListSpec,
      globalLogsSpec,
      metaGlobalRebuildSpec,
      metaGlobalRestartSpec,
      metaGlobalStartSpec,
      metaGlobalStatusSpec,
      metaGlobalStopSpec,
      metaGlobalUninstallSpec,
      metaMcpSpec,
      pluginAddSpec,
      pluginBuildSpec,
      pluginLinkSpec,
      pluginLoginSpec,
      pluginLogoutSpec,
      pluginNewSpec,
      pluginPublishSpec,
      pluginRemoveSpec,
      pluginTestSpec,
      pluginTrustSpec,
      pluginTrustAuthoringRootSpec,
      pluginUnlinkSpec,
      metaRecipesDescribeSpec,
      metaRecipesListSpec,
      metaRecipesValidateSpec,
      embeddingExempt(
        setupSpec,
        "Host setup owns process-level installation and privilege boundaries.",
        "Run `lando setup` through the native CLI.",
      ),
      embeddingExempt(
        shellenvSpec,
        "Shell environment emission depends on the invoking shell transport.",
        "Run `lando shellenv` through the native CLI and evaluate its output in the target shell.",
      ),
      embeddingExempt(
        metaUninstallSpec,
        "Host uninstall owns process-level removal and privilege boundaries.",
        "Run `lando uninstall` through the native CLI.",
      ),
      updateSpec,
      versionSpec,
      metaXSpec,
    ]
      .map(registered)
      .map((entry) => [entry.spec.id, entry]),
  ),
);

const builtInCommandIndex = buildBuiltInCommandIndex(Object.entries(builtInCommandCatalog));

export const builtInCommandEntries: ReadonlyArray<BuiltInCommandEntry> = builtInCommandIndex.entries;

export const deferredBuiltInCommandIds: ReadonlyArray<string> = builtInCommandEntries
  .filter((entry) => entry.status.kind === "deferred")
  .map((entry) => entry.spec.id);

export const isBuiltInCommandImplemented = (commandId: string): boolean =>
  builtInCommandEntries.some((entry) => entry.spec.id === commandId && entry.status.kind === "implemented");

export const resolveBuiltInCommand = (token: string | undefined): BuiltInCommandEntry | undefined =>
  token === undefined ? undefined : builtInCommandIndex.byToken.get(token);

export const isReservedNamespaceHead = (head: string | undefined): boolean =>
  head !== undefined && builtInCommandIndex.namespaceHeads.has(head);

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError => {
  const entry = builtInCommandEntries.find((candidate) => candidate.spec.id === commandId);
  return entry === undefined
    ? new NotImplementedError({
        message: `Command ${commandId} is not implemented.`,
        commandId,
        remediation:
          "This command is not available yet. Run `lando --help` to see currently available commands.",
      })
    : notImplementedErrorForSpec(entry.spec);
};

export const embeddingExemptErrorForCommand = (entry: BuiltInCommandEntry): NotImplementedError => {
  if (entry.status.kind !== "embedding-exempt") return notImplementedErrorForCommand(entry.spec.id);
  return new NotImplementedError({
    message: `Command ${entry.spec.id} cannot run through an embedded command event. ${entry.status.reason}`,
    commandId: entry.spec.id,
    remediation: entry.status.remediation,
  });
};
