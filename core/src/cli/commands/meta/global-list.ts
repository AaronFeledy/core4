import { Effect, Layer, Schema } from "effect";

import type { PluginManifestError } from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";
import { type Logger, PluginRegistry } from "@lando/sdk/services";

import { LoggerLive } from "../../../logging/service.ts";
import { PluginRegistryLive } from "../../../plugins/registry.ts";
import { type RenderContext, isDecoratedContext } from "../../renderer-boundary.ts";
import { type SummaryDocument, formatSummary } from "../../renderer/summary.ts";

export type GlobalServiceListState = "enabled" | "disabled" | "blocked";

export interface GlobalServiceListEntry {
  readonly id: string;
  readonly plugin: string;
  readonly enabled: boolean;
  readonly state: GlobalServiceListState;
  readonly summary?: string;
  readonly commands: ReadonlyArray<string>;
}

export const GlobalServiceListEntrySchema = Schema.Struct({
  id: Schema.String,
  plugin: Schema.String,
  enabled: Schema.Boolean,
  state: Schema.Literal("enabled", "disabled", "blocked"),
  summary: Schema.optional(Schema.String),
  commands: Schema.Array(Schema.String),
});

export interface GlobalListResult {
  readonly services: ReadonlyArray<GlobalServiceListEntry>;
}

export const GlobalListResultSchema = Schema.Struct({
  services: Schema.Array(GlobalServiceListEntrySchema),
});

const stateOf = (enabled: boolean): GlobalServiceListState => (enabled ? "enabled" : "disabled");

export const globalList = (): Effect.Effect<GlobalListResult, PluginManifestError, PluginRegistry> =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const manifests = yield* registry.list;

    const entries: GlobalServiceListEntry[] = [];
    for (const manifest of manifests) {
      for (const contribution of manifest.contributes?.globalServices ?? []) {
        const enabled = contribution.enabledByDefault !== false;
        entries.push({
          id: contribution.id,
          plugin: String(manifest.name),
          enabled,
          state: stateOf(enabled),
          ...(contribution.summary === undefined ? {} : { summary: contribution.summary }),
          commands: [...(contribution.commands ?? [])],
        });
      }
    }
    entries.sort((left, right) => left.id.localeCompare(right.id));

    return { services: entries };
  });

const buildGlobalListSummary = (result: GlobalListResult): SummaryDocument => {
  const rows = result.services.map((service) => ({
    label: service.id,
    tone: service.enabled ? ("ok" as const) : ("skipped" as const),
    value: service.state,
    fields: [
      { label: "plugin", value: service.plugin },
      { label: "commands", value: service.commands.length === 0 ? "none" : service.commands.join(", ") },
      ...(service.summary === undefined ? [] : [{ label: "summary", value: service.summary }]),
    ],
  }));
  return {
    title: "GLOBAL SERVICES",
    tone: "info",
    sections: [
      {
        title: "services",
        rows,
        ...(rows.length === 0 ? { notes: ["No plugins contribute global services."] } : {}),
      },
    ],
    footer: `${result.services.length} services`,
  };
};

export const renderGlobalListResult = (result: GlobalListResult, ctx?: RenderContext): string => {
  if (isDecoratedContext(ctx))
    return formatSummary(buildGlobalListSummary(result), { columns: ctx?.columns });
  if (result.services.length === 0) return "(no global services)";
  const rows = result.services.map((service) => {
    const commands = service.commands.length === 0 ? "-" : service.commands.join(",");
    return `${service.id}\t${service.state}\t${service.plugin}\t${commands}`;
  });
  return ["service\tstate\tplugin\tcommands", ...rows].join("\n");
};

// Self-provides PluginRegistry (serviceOption-backed) with a silent logger so
// the catalog listing runs at bootstrap `minimal` without provider contact.
export const DefaultGlobalListLayer: Layer.Layer<PluginRegistry | Logger, never, ConfigService> =
  PluginRegistryLive.pipe(Layer.provideMerge(LoggerLive({ mode: "silent" })));
