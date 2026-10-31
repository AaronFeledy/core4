import { readAppCommandCacheForCwdDetailed } from "@lando/engine/cache/command-index-writer";
import type {
  GraphCommandCandidate,
  PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Exit, Schema } from "effect";
import {
  isReservedNamespaceHead,
  resolveBuiltInCommand,
  suggestCommandForSuffix,
} from "./built-in-command-registry";
import { isHelpTopic } from "./cold-path-output";
import { buildCommandCatalog } from "./command-catalog";
import { escapeDiagnosticText } from "./diagnostic-text";
import { loadPluginSpec } from "./event-command-target";
import { interruptOnAbort } from "./interrupt-on-abort";
import { acquirePluginCommandMetadata } from "./plugin-command-discovery";
import { pluginTopicRows } from "./root-help-topics";

export const PluginCommandDiagnostic = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
  winner: Schema.optionalKey(
    Schema.Struct({
      source: Schema.String,
      pluginName: Schema.optionalKey(Schema.String),
      commandId: Schema.optionalKey(Schema.String),
    }),
  ),
  loser: Schema.optionalKey(
    Schema.Struct({
      source: Schema.String,
      pluginName: Schema.String,
      commandId: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type PluginCommandDiagnostic = typeof PluginCommandDiagnostic.Type;
export const PluginMetadata = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    diagnostics: Schema.optionalKey(Schema.Array(PluginCommandDiagnostic)),
    implementation: Schema.optionalKey(Schema.Literal("discovered")),
  }),
  Schema.Struct({ status: Schema.Literal("unavailable"), ...PluginCommandDiagnostic.fields }),
]);
export type PluginMetadata = typeof PluginMetadata.Type;
export type PluginCommandRow = {
  readonly id: string;
  readonly pluginName: string;
  readonly source: GraphCommandCandidate["source"];
  readonly summary: string;
  readonly descriptor: import("@lando/sdk/schema").CommandContribution;
  readonly tokens?: readonly string[];
  readonly spec?: ExecutableCommandSpec;
  readonly loadError?: PluginCommandDiagnostic;
};
export interface PluginCommandListing {
  readonly topics?: ReturnType<typeof pluginTopicRows>;
  readonly rows: readonly PluginCommandRow[];
  readonly metadata: PluginMetadata;
}

const diagnostic = Effect.fnUntraced(function* (error: unknown) {
  const service = yield* RedactionService;
  const redactor = yield* service.forProfile("secrets", { sourceEnv: process.env });
  const tagged = Schema.is(PluginCommandDiagnostic)(error);
  const bounded = (text: string) => escapeDiagnosticText(redactor.redactString(text)).slice(0, 512);
  return {
    _tag: tagged ? error._tag : "PluginLoadError",
    message: escapeDiagnosticText(redactor.redactString(tagged ? error.message : String(error))).slice(
      0,
      2048,
    ),
    ...(tagged && error.remediation !== undefined
      ? { remediation: escapeDiagnosticText(redactor.redactString(error.remediation)).slice(0, 2048) }
      : {}),
    ...(tagged && error.winner !== undefined
      ? {
          winner: {
            source: error.winner.source,
            ...(error.winner.pluginName === undefined
              ? {}
              : { pluginName: bounded(error.winner.pluginName) }),
            ...(error.winner.commandId === undefined ? {} : { commandId: bounded(error.winner.commandId) }),
          },
        }
      : {}),
    ...(tagged && error.loser !== undefined
      ? {
          loser: {
            source: error.loser.source,
            pluginName: bounded(error.loser.pluginName),
            ...(error.loser.commandId === undefined ? {} : { commandId: bounded(error.loser.commandId) }),
          },
        }
      : {}),
  };
});

/** One lazy graph and selected-spec memo per invocation, never shared between cwd/policies. */
export const createPluginCommandCatalog = (
  signal?: AbortSignal,
  acquireGraph: () => Effect.Effect<PluginContributionGraphShape, unknown> = acquirePluginCommandMetadata,
) => {
  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const exit = await Effect.runPromiseExit(interruptOnAbort(effect, signal));
    if (Exit.isFailure(exit)) throw exit.cause;
    return exit.value;
  };
  let acquisition: ReturnType<typeof acquire> | undefined;
  const acquire = () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* Effect.result(acquireGraph());
          if (result._tag === "Failure") {
            return { status: "unavailable" as const, ...(yield* diagnostic(result.failure)) };
          }
          return {
            status: "available" as const,
            graph: {
              ...result.success,
              commands: result.success.commands.filter(
                (candidate) => resolveBuiltInCommand(candidate.id) === undefined,
              ),
            },
          };
        }).pipe(Effect.provide(RedactionService.layer)),
      ),
    );
  const graph = () => {
    acquisition ??= acquire();
    return acquisition;
  };
  const specs = new Map<string, Promise<PluginCommandRow>>();
  const index = async (result: Extract<Awaited<ReturnType<typeof graph>>, { status: "available" }>) => {
    const receipt = await run(readAppCommandCacheForCwdDetailed());
    const cache = receipt.status === "fresh" ? receipt.payload : undefined;
    return buildCommandCatalog(
      result.graph.commands.map((candidate) => ({
        id: candidate.id,
        pluginName: candidate.pluginName,
        source: candidate.source,
        descriptor: candidate.descriptor,
        summary: candidate.descriptor.summary,
      })),
      cache,
    );
  };
  const load = (candidate: GraphCommandCandidate): Promise<PluginCommandRow> => {
    const cached = specs.get(candidate.id);
    if (cached !== undefined) return cached;
    const pending = run(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            loadPluginSpec(candidate.id, candidate.pluginName, candidate.load, candidate.descriptor),
          );
          const identity = {
            id: candidate.id,
            pluginName: candidate.pluginName,
            source: candidate.source,
            descriptor: candidate.descriptor,
          };
          return result._tag === "Success"
            ? { ...identity, summary: result.success.summary, spec: result.success }
            : {
                ...identity,
                summary: candidate.descriptor.summary,
                loadError: yield* diagnostic(result.failure),
              };
        }).pipe(Effect.provide(RedactionService.layer)),
      ),
    );
    specs.set(candidate.id, pending);
    return pending;
  };
  return {
    async list(namespace?: string): Promise<PluginCommandListing> {
      const result = await graph();
      if (result.status === "unavailable") return { rows: [], metadata: result };
      const catalog = await index(result);
      const rows = catalog.entries.flatMap((entry) =>
        entry.plugin === undefined || (namespace !== undefined && !entry.id.startsWith(`${namespace}:`))
          ? []
          : [{ ...entry.plugin, tokens: entry.tokens }],
      );
      const diagnostics = await run(
        Effect.forEach(
          [...(result.graph.diagnostics ?? []), ...catalog.diagnostics].slice(0, 100),
          diagnostic,
        ).pipe(Effect.provide(RedactionService.layer)),
      );
      return {
        rows,
        topics: pluginTopicRows(
          rows.map((row) => ({ ...row, hidden: row.descriptor.hidden ?? false })),
          result.graph.plugins.map((plugin) => plugin.manifest),
        ),
        metadata: { status: "available", implementation: "discovered", diagnostics },
      };
    },
    async resolve(
      id: string,
    ): Promise<PluginCommandRow | { readonly unavailable: PluginCommandDiagnostic } | undefined> {
      const result = await graph();
      if (result.status === "unavailable") {
        const { status: _status, ...unavailable } = result;
        return { unavailable };
      }
      const entry = (await index(result)).resolve(id);
      if (entry?.source !== "plugin") return undefined;
      const candidate = result.graph.commands.find((candidate) => candidate.id === entry.id);
      return candidate === undefined ? undefined : { ...(await load(candidate)), tokens: entry.tokens };
    },
    async topic(token: string) {
      if (isHelpTopic(token) || isReservedNamespaceHead(token) || token.includes(":")) return undefined;
      const result = await graph();
      if (result.status === "unavailable") return undefined;
      const owners = new Set(
        (await index(result)).entries
          .filter((entry) => !entry.hidden && entry.plugin !== undefined && entry.id.startsWith(`${token}:`))
          .map((entry) => entry.plugin?.pluginName),
      );
      if (owners.size === 0) return undefined;
      const descriptions = result.graph.plugins
        .filter((plugin) => owners.has(plugin.manifest.name))
        .map((plugin) => plugin.manifest.description);
      return {
        description:
          descriptions.length === 1 && descriptions[0]
            ? descriptions[0]
            : `Commands in the ${token} plugin namespace.`,
      };
    },
    async remediation(token: string): Promise<string | undefined> {
      const head = token.split(":", 1)[0] ?? token;
      if (isHelpTopic(head)) return `Run \`lando help ${head}\` to list commands.`;
      const result = await graph();
      const ids =
        result.status === "available"
          ? (await index(result)).entries.filter((entry) => !entry.hidden).map((entry) => entry.id)
          : [];
      if (!isReservedNamespaceHead(head) && ids.some((id) => id.startsWith(`${head}:`)))
        return `Run \`lando help ${head}\` to list commands.`;
      const suggestion = suggestCommandForSuffix(token, ids);
      return suggestion === undefined ? undefined : `Run \`lando ${suggestion}\` instead.`;
    },
    async unknownCommandRemediation(token: string): Promise<string | undefined> {
      const hint = await this.remediation(token);
      if (hint !== undefined) return hint;
      const result = await graph();
      return result.status === "unavailable"
        ? `Plugin commands could not be listed: ${result.message} ${result.remediation ?? ""}`.trimEnd()
        : undefined;
    },
  };
};
export type PluginCommandCatalog = ReturnType<typeof createPluginCommandCatalog>;
