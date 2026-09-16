import { Schema } from "effect";
import { gt, major, satisfies, valid } from "semver";

export type UpdateSelection = "all" | "core" | "plugins";

export interface AdvertisedPluginVersion {
  readonly name: string;
  readonly version: string;
  readonly requires?: Readonly<Record<string, string>>;
}

export interface PluginUpdateMetadata {
  readonly distTags: Readonly<Record<string, string>>;
  readonly versions: Readonly<Record<string, AdvertisedPluginVersion>>;
}

export interface PluginUpdateInventoryItem {
  readonly name: string;
  readonly currentVersion: string;
  readonly currentRequires?: Readonly<Record<string, string>>;
  readonly requestedSelector?: string;
  readonly source?: "installed" | "linked";
  readonly bundled?: boolean;
  readonly trusted: boolean;
  readonly metadata?: PluginUpdateMetadata;
}

export type PluginUpdateReason =
  | "apply-failed"
  | "current-core-incompatible"
  | "downgrade"
  | "invalid-current-version"
  | "invalid-target-version"
  | "linked"
  | "major-change"
  | "metadata-mismatch"
  | "metadata-unavailable"
  | "plugin-compatibility"
  | "selected"
  | "selector-unknown"
  | "target-core-incompatible"
  | "trust-required"
  | "up-to-date"
  | "bundled-with-core";

export interface CoreUpdatePlanRow {
  readonly kind: "core";
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly status: "blocked" | "unchanged" | "update";
  readonly reason?: PluginUpdateReason;
}

export interface PluginUpdatePlanRow {
  readonly kind: "plugin";
  readonly name: string;
  readonly currentVersion: string;
  readonly targetVersion?: string | undefined;
  readonly selector?: string | undefined;
  readonly status: "failed" | "held" | "unchanged" | "update";
  readonly reason: PluginUpdateReason;
}

export const PluginUpdatePlanRowSchema = Schema.Struct({
  kind: Schema.Literal("plugin"),
  name: Schema.String,
  currentVersion: Schema.String,
  targetVersion: Schema.optional(Schema.String),
  selector: Schema.optional(Schema.String),
  status: Schema.Literal("failed", "held", "unchanged", "update"),
  reason: Schema.Literal(
    "current-core-incompatible",
    "apply-failed",
    "downgrade",
    "invalid-current-version",
    "invalid-target-version",
    "linked",
    "major-change",
    "metadata-mismatch",
    "metadata-unavailable",
    "plugin-compatibility",
    "selected",
    "selector-unknown",
    "target-core-incompatible",
    "trust-required",
    "up-to-date",
    "bundled-with-core",
  ),
});

export type UpdatePlanRow = CoreUpdatePlanRow | PluginUpdatePlanRow;

export interface UpdatePlan {
  readonly rows: ReadonlyArray<UpdatePlanRow>;
  readonly hasFailures: boolean;
}

export interface PlanUpdatesInput {
  readonly currentCoreVersion: string;
  readonly targetCoreVersion: string;
  readonly selection: UpdateSelection;
  readonly plugins: ReadonlyArray<PluginUpdateInventoryItem>;
}

const supportsCore = (requires: Readonly<Record<string, string>> | undefined, version: string): boolean => {
  const range = requires?.["@lando/core"];
  return range !== undefined && satisfies(version, range, { includePrerelease: true });
};

const held = (plugin: PluginUpdateInventoryItem, reason: PluginUpdateReason): PluginUpdatePlanRow => ({
  kind: "plugin",
  name: plugin.name,
  currentVersion: plugin.currentVersion,
  ...(plugin.requestedSelector === undefined ? {} : { selector: plugin.requestedSelector }),
  status: "held",
  reason,
});

const planPlugin = (
  plugin: PluginUpdateInventoryItem,
  currentCoreVersion: string,
  targetCoreVersion: string,
  combined: boolean,
): PluginUpdatePlanRow => {
  if (plugin.bundled === true) return held(plugin, "bundled-with-core");
  if (plugin.source === "linked") return held(plugin, "linked");
  if (plugin.requestedSelector === undefined) return held(plugin, "selector-unknown");
  const current = valid(plugin.currentVersion);
  if (current === null) return { ...held(plugin, "invalid-current-version"), status: "failed" };
  const exactSelector = valid(plugin.requestedSelector);
  if (!plugin.trusted) return held(plugin, "trust-required");
  if (exactSelector === current) {
    return { ...held(plugin, "up-to-date"), targetVersion: current, status: "unchanged" };
  }
  if (plugin.metadata === undefined) return held(plugin, "metadata-unavailable");
  const target = exactSelector ?? plugin.metadata.distTags[plugin.requestedSelector];
  if (target === undefined) return held(plugin, "metadata-unavailable");
  const targetVersion = valid(target);
  if (targetVersion === null) return { ...held(plugin, "invalid-target-version"), status: "failed" };
  const advertised = plugin.metadata.versions[target];
  if (advertised === undefined) return held(plugin, "metadata-unavailable");
  if (advertised.name !== plugin.name || advertised.version !== target) {
    return { ...held(plugin, "metadata-mismatch"), targetVersion: target, status: "failed" };
  }
  if (major(targetVersion) !== major(current)) {
    return { ...held(plugin, "major-change"), targetVersion, status: "failed" };
  }
  if (gt(current, targetVersion)) {
    return { ...held(plugin, "downgrade"), targetVersion, status: "failed" };
  }
  if (current === targetVersion) {
    return { ...held(plugin, "up-to-date"), targetVersion: current, status: "unchanged" };
  }
  if (!supportsCore(advertised.requires, currentCoreVersion)) {
    return { ...held(plugin, "current-core-incompatible"), targetVersion };
  }
  if (combined && !supportsCore(advertised.requires, targetCoreVersion)) {
    return { ...held(plugin, "target-core-incompatible"), targetVersion };
  }
  return {
    kind: "plugin",
    name: plugin.name,
    currentVersion: plugin.currentVersion,
    targetVersion,
    selector: plugin.requestedSelector,
    status: "update",
    reason: "selected",
  };
};

export const planUpdates = (input: PlanUpdatesInput): UpdatePlan => {
  const combined = input.selection !== "plugins" && input.currentCoreVersion !== input.targetCoreVersion;
  const plugins =
    input.selection === "core"
      ? []
      : [...input.plugins]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((plugin) => planPlugin(plugin, input.currentCoreVersion, input.targetCoreVersion, combined));
  const incompatibleTarget = combined
    ? input.plugins.some((plugin) => {
        if (plugin.bundled === true) return false;
        const planned = plugins.find((row) => row.name === plugin.name);
        const requirements =
          planned?.status === "update" && planned.targetVersion !== undefined
            ? plugin.metadata?.versions[planned.targetVersion]?.requires
            : plugin.currentRequires;
        return !supportsCore(requirements, input.targetCoreVersion);
      })
    : false;
  const coreRows: ReadonlyArray<CoreUpdatePlanRow> =
    input.selection === "plugins"
      ? []
      : [
          incompatibleTarget
            ? {
                kind: "core",
                currentVersion: input.currentCoreVersion,
                targetVersion: input.targetCoreVersion,
                status: "blocked",
                reason: "plugin-compatibility",
              }
            : {
                kind: "core",
                currentVersion: input.currentCoreVersion,
                targetVersion: input.targetCoreVersion,
                status: input.currentCoreVersion === input.targetCoreVersion ? "unchanged" : "update",
              },
        ];
  const rows: ReadonlyArray<UpdatePlanRow> = [...coreRows, ...plugins];
  return {
    rows,
    hasFailures: rows.some((row) => row.status === "failed" || row.status === "blocked"),
  };
};
