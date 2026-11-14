import {
  type AppCommandCacheReadResult,
  readAppCommandCacheForCwdDetailed,
} from "@lando/engine/cache/command-index-writer";
import type {
  GraphCommandCandidate,
  PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { resolveLandoRoots } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { closestKeys } from "@lando/sdk/schema";
import { Effect, Exit, Schema } from "effect";
import { CliInvocation, type CliInvocationContext } from "../runtime/invocation-context";
import {
  isReservedNamespaceHead,
  resolveBuiltInCommand,
  suggestCommandForSuffix,
} from "./built-in-command-registry";
import { isHelpTopic } from "./cold-path-output";
import { type CommandCatalog, type CommandCatalogEntry, buildCommandCatalog } from "./command-catalog";
import { escapeDiagnosticText } from "./diagnostic-text";
import { loadPluginSpec } from "./event-command-target";
import { interruptOnAbort } from "./interrupt-on-abort";
import { acquirePluginCommandMetadata } from "./plugin-command-discovery";
import { pluginTopicRows } from "./root-help-topics";
import { UNKNOWN_COMMAND_FALLBACK, type UnknownCommandGuidance } from "./unknown-command-error";

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
  const redactor = yield* service.forProfile("secrets", { sourceEnv: (yield* CliInvocation).env });
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

const pluginAliasHint = (token: string, catalog: CommandCatalog | undefined): string | undefined => {
  const aliased = catalog?.resolve(token);
  return aliased?.source === "plugin" && aliased.id !== token
    ? `Run \`lando ${aliased.id}\` to run the plugin command directly.`
    : undefined;
};

const namespaceHint = (token: string, catalog: CommandCatalog | undefined): string | undefined => {
  const head = token.split(":", 1)[0] ?? token;
  if (isHelpTopic(head)) return `Run \`lando help ${head}\` to list commands.`;
  const ids = catalog?.entries.filter((entry) => !entry.hidden).map((entry) => entry.id) ?? [];
  if (!isReservedNamespaceHead(head) && ids.some((id) => id.startsWith(`${head}:`)))
    return `Run \`lando help ${head}\` to list commands.`;
  const suggestion = suggestCommandForSuffix(token, ids);
  return suggestion === undefined ? undefined : `Run \`lando ${suggestion}\` instead.`;
};

const suggestable = (entry: CommandCatalogEntry | undefined): entry is CommandCatalogEntry =>
  entry !== undefined && !entry.hidden && entry.deferred === undefined;

// One edit for short words, two for longer ones; a single character is too short to guess from.
const typoBudget = (token: string): number => {
  const segment = token.slice(token.lastIndexOf(":") + 1);
  return segment.length <= 1 ? 0 : segment.length <= 4 ? 1 : 2;
};

/**
 * Routable spellings nearest to what was typed, best first: space-separated
 * words joined into a colon id (`meta version` -> `meta:version`), else the
 * closest visible tokens, at most one per command.
 */
const closestCommandSpellings = (
  argv: ReadonlyArray<string>,
  catalog: CommandCatalog,
): ReadonlyArray<{ readonly spelling: string; readonly entry: CommandCatalogEntry }> => {
  const token = argv[0];
  if (token === undefined || escapeDiagnosticText(token) !== token) return [];
  const words: string[] = [];
  for (const word of argv.slice(0, 4)) {
    if (word.startsWith("-") || escapeDiagnosticText(word) !== word) break;
    words.push(word);
  }
  for (let count = words.length; count >= 2; count -= 1) {
    const spelling = words.slice(0, count).join(":");
    const entry = catalog.resolve(spelling);
    if (suggestable(entry)) return [{ spelling, entry }];
  }
  const budget = typoBudget(token);
  if (budget === 0) return [];
  const spellings = catalog.entries
    .filter(suggestable)
    .flatMap((entry) => entry.tokens)
    .filter((candidate) => !candidate.startsWith("-"));
  const matches: { readonly spelling: string; readonly entry: CommandCatalogEntry }[] = [];
  for (const spelling of closestKeys(token, spellings, budget, spellings.length)) {
    const entry = catalog.resolve(spelling);
    if (entry === undefined || matches.some((match) => match.entry.id === entry.id)) continue;
    matches.push({ spelling, entry });
    if (matches.length === 3) break;
  }
  return matches;
};

/** One lazy graph and selected-spec memo per invocation, never shared between cwd/policies. */
export const createPluginCommandCatalog = (
  signal?: AbortSignal,
  acquireGraph: () => Effect.Effect<PluginContributionGraphShape, unknown> = acquirePluginCommandMetadata,
  context?: CliInvocationContext,
) => {
  const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const operation =
      context === undefined ? effect : effect.pipe(Effect.provideService(CliInvocation, context));
    const exit = await Effect.runPromiseExit(interruptOnAbort(operation, signal));
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
  // A fresh index stays fresh for this invocation; a miss is re-read because a rebuild may follow it.
  let freshCache: Extract<AppCommandCacheReadResult, { readonly status: "fresh" }>["payload"] | undefined;
  const freshAppCommandCache = async () => {
    if (freshCache !== undefined) return freshCache;
    const roots = context === undefined ? undefined : resolveLandoRoots({ env: context.env });
    const receipt = await run(
      readAppCommandCacheForCwdDetailed(
        context === undefined || roots === undefined
          ? {}
          : { cwd: context.cwd, env: context.env, cacheRoot: roots.userCacheRoot, roots },
      ),
    );
    if (receipt.status === "fresh") freshCache = receipt.payload;
    return freshCache;
  };
  const index = async (result: Extract<Awaited<ReturnType<typeof graph>>, { status: "available" }>) =>
    buildCommandCatalog(
      result.graph.commands.map((candidate) => ({
        id: candidate.id,
        pluginName: candidate.pluginName,
        source: candidate.source,
        descriptor: candidate.descriptor,
        summary: candidate.descriptor.summary,
      })),
      await freshAppCommandCache(),
    );
  // Failed plugin discovery still leaves built-ins and this app's tasks to suggest.
  const suggestionCatalog = async (result: Awaited<ReturnType<typeof graph>>) =>
    result.status === "available" ? index(result) : buildCommandCatalog([], await freshAppCommandCache());
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
    context,
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
      const catalog = result.status === "available" ? await index(result) : undefined;
      return pluginAliasHint(token, catalog) ?? namespaceHint(token, catalog);
    },
    /** Whether a non-plugin command is spelled close to `argv`, even when plugin discovery failed. */
    async hasCloseSpelling(argv: ReadonlyArray<string>): Promise<boolean> {
      return closestCommandSpellings(argv, await suggestionCatalog(await graph())).length > 0;
    },
    /** Remediation for a token no command owns: the closest routable spelling first, then topic hints. */
    async unknownCommandGuidance(argv: ReadonlyArray<string>): Promise<UnknownCommandGuidance> {
      const token = argv[0] ?? "";
      const result = await graph();
      const catalog = await suggestionCatalog(result);
      const unavailable =
        result.status === "unavailable"
          ? `Plugin commands could not be listed: ${result.message} ${result.remediation ?? ""}`.trimEnd()
          : undefined;
      const withUnavailable = (hint: string) => (unavailable === undefined ? hint : `${hint} ${unavailable}`);
      const alias = pluginAliasHint(token, catalog);
      if (alias !== undefined) return { remediation: alias };
      const [closest, ...others] = closestCommandSpellings(argv, catalog);
      if (closest !== undefined) {
        const { spelling, entry } = closest;
        // A colon id also names its short top-level spelling when it has one.
        const alternative =
          spelling.includes(":") && !entry.primary.includes(":") ? ` or \`lando ${entry.primary}\`` : "";
        return {
          suggestions: [spelling, ...others.map((other) => other.spelling)],
          remediation: withUnavailable(`Did you mean \`lando ${spelling}\`${alternative}?`),
        };
      }
      const hint = namespaceHint(token, catalog);
      if (hint === undefined && unavailable === undefined) return {};
      return { remediation: withUnavailable(hint ?? UNKNOWN_COMMAND_FALLBACK) };
    },
  };
};
export type PluginCommandCatalog = ReturnType<typeof createPluginCommandCatalog>;
