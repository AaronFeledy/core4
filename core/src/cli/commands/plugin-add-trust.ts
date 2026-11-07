import { InteractionRequiredError, NotImplementedError } from "@lando/sdk/errors";
import type { PluginTrustStore as PersistentPluginTrustStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { makePromiseInteractionPrompter } from "../../interaction/prompter";
import { makeInteractionService } from "../../interaction/service";
import type { PluginAddOptions, PluginTrustStore } from "./plugin-add-options";

export const globalTrustStore: PluginTrustStore = new Set<string>();

export const ensureTrust = async (
  identity: { readonly packageName: string; readonly manifestName: string },
  options: PluginAddOptions,
  persistentStore?: typeof PersistentPluginTrustStore.Service,
): Promise<"flag" | "persistent" | "prompt" | "session"> => {
  const store = options.trustStore ?? globalTrustStore;
  const trustName = identity.packageName;
  if (store.has(trustName)) return "session";
  if (
    persistentStore !== undefined &&
    (await Effect.runPromise(persistentStore.isPluginTrusted(trustName)))
  ) {
    store.add(trustName);
    return "persistent";
  }
  if (options.trust === true) {
    store.add(trustName);
    if (persistentStore !== undefined) await Effect.runPromise(persistentStore.trustPlugin(trustName));
    return "flag";
  }
  if (options.nonInteractive === true)
    throw new InteractionRequiredError({
      message: "Plugin trust prompt cannot run non-interactively without --trust.",
      promptName: "trust",
      remediation: `Re-run \`lando plugin:add ${options.spec} --trust\` to confirm the plugin should run as trusted host code, or persist trust first with \`lando plugin:trust <name>\`.`,
    });
  const ok =
    options.prompter === undefined
      ? await (options.interaction ?? makePromiseInteractionPrompter(makeInteractionService())).confirm({
          message: `Plugin ${identity.manifestName} will run as TRUSTED HOST CODE.\nTrust this plugin for the current Lando session?`,
          name: "trust",
          default: false,
        })
      : await options.prompter.confirmTrust({ pluginName: identity.manifestName, spec: options.spec });
  if (!ok)
    throw new NotImplementedError({
      message: `User declined to trust plugin ${identity.manifestName}.`,
      commandId: "meta:plugin:add",
      remediation: "Re-run with --trust if you intend to trust the plugin as host code.",
    });
  store.add(trustName);
  return "prompt";
};
