import {
  type GraphCommandCandidate,
  PluginContributionGraph,
  type PluginContributionGraphShape,
} from "@lando/engine/plugins/contribution-graph";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { RedactionService } from "@lando/redaction/service";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Exit, Schema } from "effect";
import { makeLandoRuntime } from "../runtime/layer";
import {
  isReservedNamespaceHead,
  resolveBuiltInCommand,
  suggestCommandForSuffix,
} from "./built-in-command-registry";
import { isHelpTopic } from "./cold-path-output";
import { loadPluginSpec } from "./event-command-target";
import { interruptOnAbort } from "./interrupt-on-abort";

export const PluginCommandDiagnostic = Schema.Struct({
  _tag: Schema.String,
  message: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
});
export type PluginCommandDiagnostic = typeof PluginCommandDiagnostic.Type;
export const PluginMetadata = Schema.Union([
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({ status: Schema.Literal("unavailable"), ...PluginCommandDiagnostic.fields }),
]);
export type PluginMetadata = typeof PluginMetadata.Type;
export type PluginCommandRow = {
  readonly id: string;
  readonly pluginName: string;
  readonly source: GraphCommandCandidate["source"];
  readonly summary: string;
  readonly spec?: ExecutableCommandSpec;
  readonly loadError?: PluginCommandDiagnostic;
};
export interface PluginCommandListing {
  readonly rows: readonly PluginCommandRow[];
  readonly metadata: PluginMetadata;
}

const diagnostic = Effect.fnUntraced(function* (error: unknown) {
  const service = yield* RedactionService;
  const redactor = yield* service.forProfile("secrets", { sourceEnv: process.env });
  const tagged = Schema.is(PluginCommandDiagnostic)(error);
  return {
    _tag: tagged ? error._tag : "PluginLoadError",
    message: redactor.redactString(tagged ? error.message : String(error)).slice(0, 2048),
    ...(tagged && error.remediation !== undefined
      ? { remediation: redactor.redactString(error.remediation).slice(0, 2048) }
      : {}),
  };
});

const acquirePluginCommandGraph = Effect.fnUntraced(function* () {
  const cwd = yield* discoveryCwd();
  return yield* Effect.scoped(
    PluginContributionGraph.pipe(
      Effect.provide(
        makeLandoRuntime(cliRuntimeOptions({ bootstrap: "plugins", cwd, plugins: { policy: "discovery" } })),
      ),
    ),
  );
});

/** One lazy graph and selected-spec memo per invocation, never shared between cwd/policies. */
export const createPluginCommandCatalog = (
  signal?: AbortSignal,
  acquireGraph: () => Effect.Effect<PluginContributionGraphShape, unknown> = acquirePluginCommandGraph,
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
  const load = (candidate: GraphCommandCandidate): Promise<PluginCommandRow> => {
    const cached = specs.get(candidate.id);
    if (cached !== undefined) return cached;
    const pending = run(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* Effect.result(
            loadPluginSpec(candidate.id, candidate.pluginName, candidate.load),
          );
          const identity = { id: candidate.id, pluginName: candidate.pluginName, source: candidate.source };
          return result._tag === "Success"
            ? { ...identity, summary: result.success.summary, spec: result.success }
            : { ...identity, summary: "unavailable", loadError: yield* diagnostic(result.failure) };
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
      const candidates = result.graph.commands.filter(
        (candidate) => namespace === undefined || candidate.id.startsWith(`${namespace}:`),
      );
      const rows = await Promise.all(candidates.map(load));
      return { rows: rows.sort((a, b) => a.id.localeCompare(b.id)), metadata: { status: "available" } };
    },
    async resolve(
      id: string,
    ): Promise<PluginCommandRow | { readonly unavailable: PluginCommandDiagnostic } | undefined> {
      const result = await graph();
      if (result.status === "unavailable") {
        const { status: _status, ...unavailable } = result;
        return { unavailable };
      }
      const candidate = result.graph.commands.find((candidate) => candidate.id === id);
      return candidate === undefined ? undefined : load(candidate);
    },
    async topic(token: string) {
      if (isHelpTopic(token) || isReservedNamespaceHead(token) || token.includes(":")) return undefined;
      const result = await graph();
      if (result.status === "unavailable") return undefined;
      const owners = new Set(
        result.graph.commands
          .filter((candidate) => candidate.id.startsWith(`${token}:`))
          .map((candidate) => candidate.pluginName),
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
      const ids = result.status === "available" ? result.graph.commands.map((candidate) => candidate.id) : [];
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
