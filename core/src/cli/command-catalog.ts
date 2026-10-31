import type { AppCommandIndexPayload } from "@lando/engine/cache/command-index";
import type { ManifestDiagnostic } from "@lando/engine/plugins/manifest-selection";
import type { CommandContribution } from "@lando/sdk/schema";
import type { DeferredCommandPlan } from "./deferred-commands";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import type { HelpAliasPolicy } from "./help-names";
import { typeableName } from "./help-names";
import type { PluginCommandRow } from "./plugin-command-catalog";

export interface CommandCatalogEntry {
  readonly id: string;
  readonly summary: string;
  readonly source: "built-in" | "plugin" | "tooling";
  readonly hidden: boolean;
  readonly tokens: readonly string[];
  readonly primary: string;
  readonly extras: readonly string[];
  readonly plugin?: PluginCommandRow;
  readonly mcpAllowed?: boolean;
  readonly deferred?: DeferredCommandPlan;
}
export interface CommandCatalog {
  readonly entries: readonly CommandCatalogEntry[];
  readonly byToken: ReadonlyMap<string, CommandCatalogEntry>;
  readonly diagnostics: readonly ManifestDiagnostic[];
  readonly resolve: (token: string) => CommandCatalogEntry | undefined;
}
export const commandDescriptorAliases = (descriptor: CommandContribution): readonly string[] => {
  const top = descriptor.topLevelAlias;
  const aliases =
    top === true
      ? [descriptor.id.replace(/^[^:]+:/u, "")]
      : top === false || top === undefined
        ? []
        : Array.isArray(top)
          ? top
          : [top];
  return [
    ...new Set(
      [...aliases, ...(descriptor.aliases ?? [])].map((alias) =>
        typeof alias === "string" ? alias : alias.name,
      ),
    ),
  ];
};
export const commandDescriptorNotice = (descriptor: CommandContribution, token: string) => {
  if (token === descriptor.id) return descriptor.deprecated;
  const top = descriptor.topLevelAlias;
  const aliases = [
    ...(descriptor.aliases ?? []),
    ...(top === true || top === false || top === undefined ? [] : Array.isArray(top) ? top : [top]),
  ];
  const alias = aliases.find((entry) => typeof entry !== "string" && entry.name === token);
  return typeof alias === "object" ? alias.deprecated : undefined;
};
const reserved = (token: string) =>
  ["help", "run", "app", "apps", "meta", "plugin", "global", "recipes", "scratch"].includes(token) ||
  /^(scratch:|global:|meta:plugin:|meta:global:|plugin:|-)/u.test(token);
const builtIns: Readonly<
  Record<
    string,
    {
      readonly spec: {
        readonly id: string;
        readonly summary: string;
        readonly mcpAllowed?: boolean;
        readonly deferred?: DeferredCommandPlan;
      };
      readonly aliases: readonly string[];
      readonly hidden: boolean;
    }
  >
> = COMMAND_REGISTRY_MANIFEST.commands;

export const buildCommandCatalog = (
  plugins: readonly PluginCommandRow[] = [],
  cache?: Pick<AppCommandIndexPayload, "entries" | "aliasPolicy"> | null,
): CommandCatalog => {
  const policy: HelpAliasPolicy | undefined = cache?.aliasPolicy;
  const entries: CommandCatalogEntry[] = [];
  const byToken = new Map<string, CommandCatalogEntry>();
  const diagnostics: ManifestDiagnostic[] = [];
  const add = (entry: CommandCatalogEntry) => {
    entries.push(entry);
    byToken.set(entry.id, entry);
  };
  for (const command of Object.values(builtIns))
    add({
      id: command.spec.id,
      summary: command.spec.summary,
      source: "built-in",
      hidden: command.hidden === true,
      tokens: [],
      primary: command.spec.id,
      extras: [],
      ...(command.spec.mcpAllowed === undefined ? {} : { mcpAllowed: command.spec.mcpAllowed }),
      ...(command.spec.deferred === undefined ? {} : { deferred: command.spec.deferred }),
    });
  for (const command of cache?.entries ?? [])
    if (!byToken.has(command.id))
      add({
        id: command.id,
        summary: command.summary,
        source: "tooling",
        hidden: command.hidden,
        tokens: [],
        primary: command.id,
        extras: [],
      });
  for (const plugin of plugins)
    if (
      !byToken.has(plugin.id) &&
      !Object.values(builtIns).some((entry) => entry.aliases.includes(plugin.id))
    )
      add({
        id: plugin.id,
        summary: plugin.summary,
        source: "plugin",
        hidden: plugin.descriptor.hidden === true,
        tokens: [],
        primary: plugin.id,
        extras: [],
        plugin,
        ...(plugin.descriptor.mcpAllowed === undefined ? {} : { mcpAllowed: plugin.descriptor.mcpAllowed }),
      });
  const publish = (entry: CommandCatalogEntry, aliases: readonly string[]) => {
    const accepted: string[] = [];
    for (const token of aliases) {
      if (
        policy?.enabled === false ||
        policy?.disabled?.includes(token) ||
        (policy?.custom?.[token] !== undefined && policy.custom[token] !== entry.id)
      )
        continue;
      const winner = byToken.get(token);
      if (
        (winner !== undefined && winner.id !== entry.id) ||
        (entry.source === "plugin" && reserved(token) && policy?.custom?.[token] !== entry.id)
      ) {
        if (entry.plugin !== undefined && diagnostics.length < 100)
          diagnostics.push({
            _tag: "CommandAliasConflictError",
            message: `Alias ${token} for ${entry.id} (${entry.plugin.pluginName}) is ignored because ${
              winner === undefined ? "Lando reserves it" : `${winner.id} owns it`
            }.`,
            remediation: `Run \`lando ${entry.id}\`, or give the plugin command a different alias.`,
            winner:
              winner === undefined
                ? { source: "core" }
                : winner.plugin === undefined
                  ? { source: winner.source === "tooling" ? "tooling" : "built-in", commandId: winner.id }
                  : {
                      source: winner.plugin.source,
                      pluginName: winner.plugin.pluginName,
                      commandId: winner.id,
                    },
            loser: { pluginName: entry.plugin.pluginName, source: entry.plugin.source, commandId: entry.id },
          });
        continue;
      }
      accepted.push(token);
      byToken.set(token, entry);
    }
    const name = typeableName({
      canonicalId: entry.id,
      builtInAliases: entry.source === "tooling" ? [] : accepted,
      ...(policy === undefined ? {} : { aliasPolicy: policy }),
    });
    const resolved = {
      ...entry,
      primary: name.primary,
      extras: name.extras,
      tokens: [...new Set([entry.id, ...accepted])],
    };
    entries[entries.indexOf(entry)] = resolved;
    for (const token of resolved.tokens) byToken.set(token, resolved);
  };
  for (const entry of [...entries].sort(
    (a, b) =>
      ({ "built-in": 0, tooling: 1, plugin: 2 })[a.source] -
      { "built-in": 0, tooling: 1, plugin: 2 }[b.source],
  )) {
    const aliases =
      entry.source === "built-in"
        ? (builtIns[entry.id]?.aliases ?? [])
        : entry.source === "tooling"
          ? [entry.id.slice(4)]
          : entry.plugin === undefined
            ? []
            : commandDescriptorAliases(entry.plugin.descriptor);
    const customs = Object.entries(policy?.custom ?? {})
      .filter(([, id]) => id === entry.id)
      .map(([token]) => token);
    publish(entry, [...customs, ...aliases]);
  }
  return { entries, byToken, diagnostics, resolve: (token) => byToken.get(token) };
};
