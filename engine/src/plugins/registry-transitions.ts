import { defineTransitions, planTransition } from "@lando/sdk/transitions";

import type { InstalledPluginRegistryEntry } from "./installed-registry.ts";

export class PluginLinkConflictCauseError extends Error {
  readonly code = "PLUGIN_LINK_CONFLICT";
  constructor(
    readonly pluginName: string,
    readonly existingPath: string,
  ) {
    super(
      `Plugin ${pluginName} already exists at ${existingPath}; refusing to replace a conflicting registry entry.`,
    );
    this.name = "PluginLinkConflict";
  }
}

export class PluginUnlinkNotLinkedCauseError extends Error {
  readonly code = "PLUGIN_UNLINK_NOT_LINKED";
  constructor(readonly pluginName: string) {
    super(`Plugin ${pluginName} is not linked; nothing to unlink.`);
    this.name = "PluginUnlinkNotLinked";
  }
}

/** The refusals a registry mutation can fail with; each names the conflicting plugin. */
export type InstalledPluginRegistryRejection = PluginLinkConflictCauseError | PluginUnlinkNotLinkedCauseError;

export const isInstalledPluginRegistryRejection = (
  cause: unknown,
): cause is InstalledPluginRegistryRejection =>
  cause instanceof PluginLinkConflictCauseError || cause instanceof PluginUnlinkNotLinkedCauseError;

export const installedPluginRegistryTransitions = defineTransitions<InstalledPluginRegistryState>()({
  install: { from: ["absent", "installed"], to: "installed" },
  remove: { from: ["installed", "linked"], to: "absent", settledIn: ["absent"] },
  link: { from: ["absent", "linked"], to: "linked" },
  unlink: { from: ["linked"], to: "absent" },
  // Compensation runs only within the failed publication's lock. An atomic
  // writer can reject before or after rename, so either state may be on disk.
  "rollback-absent": { from: ["absent", "installed", "linked"], to: "absent" },
  "rollback-installed": { from: ["installed", "absent"], to: "installed" },
  "rollback-linked": { from: ["linked", "absent"], to: "linked" },
});

export type InstalledPluginRegistryMutation =
  | {
      readonly operation: "install";
      readonly entry: Omit<InstalledPluginRegistryEntry, "source" | "linkedPath">;
    }
  | {
      readonly operation: "link";
      readonly entry: Omit<InstalledPluginRegistryEntry, "source"> & { readonly linkedPath: string };
    }
  | { readonly operation: "remove" | "unlink"; readonly name: string };

export type InstalledPluginRegistryWritePlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Delete" }
  | { readonly _tag: "Store"; readonly entry: InstalledPluginRegistryEntry }
  | {
      readonly _tag: "Reject";
      readonly cause: PluginLinkConflictCauseError | PluginUnlinkNotLinkedCauseError;
    };

export type InstalledPluginRegistryState = "absent" | "installed" | "linked";

export const installedPluginRegistryState = (
  entry: InstalledPluginRegistryEntry | undefined,
): InstalledPluginRegistryState => (entry === undefined ? "absent" : (entry.source ?? "installed"));

/** The operation picks the stored entry; callers supply only its fields. */
export const planInstalledPluginRegistryWrite = (
  mutation: InstalledPluginRegistryMutation,
  previous: InstalledPluginRegistryEntry | undefined,
): InstalledPluginRegistryWritePlan => {
  const name = "entry" in mutation ? mutation.entry.name : mutation.name;
  const plan = planTransition(
    installedPluginRegistryTransitions,
    mutation.operation,
    installedPluginRegistryState(previous),
    (to): InstalledPluginRegistryEntry | null => {
      if (to === "absent") return null;
      switch (mutation.operation) {
        case "remove":
        case "unlink":
          return null;
        case "install":
          return {
            name: mutation.entry.name,
            version: mutation.entry.version,
            path: mutation.entry.path,
            ...(mutation.entry.requestedSelector === undefined
              ? {}
              : { requestedSelector: mutation.entry.requestedSelector }),
            source: to,
          };
        case "link":
          return { ...mutation.entry, source: to };
      }
    },
  );
  switch (plan._tag) {
    case "Keep":
      return { _tag: "Unchanged" };
    case "Illegal":
      return {
        _tag: "Reject",
        cause:
          mutation.operation === "unlink"
            ? new PluginUnlinkNotLinkedCauseError(name)
            : new PluginLinkConflictCauseError(name, previous?.path ?? name),
      };
    case "Write":
      return plan.value === null ? { _tag: "Delete" } : { _tag: "Store", entry: plan.value };
  }
};
