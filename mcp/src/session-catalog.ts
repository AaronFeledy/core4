import type { Redactor } from "@lando/sdk/secrets";
import { Context, Effect, Semaphore } from "effect";
import * as McpSchema from "effect/ai/McpSchema";
import type * as McpServer from "effect/ai/McpServer";

import { type McpAppGeneration, generationEntries } from "./apps";
import { type McpAllowPolicy, isMcpEntryAuthorized, isMcpToolingAuthorized } from "./catalog";
import {
  type McpDiagnostic,
  type McpDiagnostics,
  type McpToolingCatalog,
  boundDiagnostics,
  pluginDiagnostics,
} from "./diagnostics";
import type { McpCommandEntry } from "./registry";
import { type McpToolVariant, makeToolVariant, unionTool } from "./tool-variants";

/** Variant slot for session-wide owners, which are identical for every app. */
const SESSION_VARIANT = "session";

type McpServerShape = Context.Service.Shape<typeof McpServer.McpServer>;
type ToolHandler = Parameters<McpServerShape["addTool"]>[0]["handle"];

export interface McpToolPublication {
  readonly added: readonly string[];
  readonly changed: readonly string[];
}

interface McpCatalogSnapshot {
  readonly revision: number;
  readonly tooling: McpToolingCatalog;
  readonly selected: McpAppGeneration | undefined;
  readonly advertised: ReadonlyMap<string, ReadonlySet<string>>;
  readonly diagnostics: McpDiagnostics;
}

const sameSignatures = (left: ReadonlySet<string> | undefined, right: ReadonlySet<string>): boolean =>
  left !== undefined && left.size === right.size && [...right].every((signature) => left.has(signature));

const byId = (left: string, right: string) => left.localeCompare(right);

export const makeSessionCatalog = Effect.fnUntraced(function* (input: {
  readonly server: McpServerShape;
  readonly policy: McpAllowPolicy;
  /** Session-wide owners (built-ins and, with tooling on, tooling tasks). */
  readonly entries: ReadonlyArray<McpCommandEntry>;
  readonly unavailable: readonly McpDiagnostic[];
  readonly handle: (toolId: string) => ToolHandler;
  readonly sessionKey?: string;
  readonly redactor: Redactor;
}) {
  const sessionIds = new Set(
    input.entries.filter((entry) => entry.tooling !== true).map((entry) => entry.spec.id),
  );
  const variants = new Map<string, Map<string, McpToolVariant>>();
  const published = new Map<string, ReadonlySet<string>>();
  const projected = new WeakSet<McpAppGeneration>();
  const signatures = new WeakMap<McpCommandEntry, string>();
  const publication = yield* Semaphore.make(1);
  let snapshot: McpCatalogSnapshot = Object.freeze({
    revision: 0,
    tooling: {
      revision: "initial",
      entries: input.entries.filter((entry) => entry.tooling === true),
      unavailable: input.unavailable,
    },
    selected: undefined,
    advertised: new Map(),
    diagnostics: boundDiagnostics(0, [], input.redactor),
  });
  const authorized = (entry: McpCommandEntry) => isMcpEntryAuthorized(input.policy, entry);

  const setVariant = (toolId: string, slot: string, variant: McpToolVariant) => {
    const slots = variants.get(toolId) ?? new Map<string, McpToolVariant>();
    slots.set(slot, variant);
    variants.set(toolId, slots);
    signatures.set(variant.entry, variant.signature);
  };

  const publishTool = Effect.fnUntraced(function* (toolId: string) {
    const [first, ...rest] = [...(variants.get(toolId)?.values() ?? [])];
    if (first === undefined) {
      const previous = published.get(toolId);
      published.delete(toolId);
      return previous === undefined ? undefined : ("changed" as const);
    }
    const union = unionTool(toolId, [first, ...rest]);
    const previous = published.get(toolId);
    if (sameSignatures(previous, union.signatures)) return undefined;
    // Upsert by name; the server announces notifications/tools/list_changed.
    yield* input.server.addTool({
      tool: union.tool,
      annotations: Context.make(McpSchema.EnabledWhen, () => snapshot.advertised.has(toolId)),
      handle: input.handle(toolId),
    });
    published.set(toolId, union.signatures);
    return previous === undefined ? ("added" as const) : ("changed" as const);
  });

  for (const entry of input.entries)
    if (authorized(entry)) setVariant(entry.spec.id, SESSION_VARIANT, makeToolVariant(entry, undefined));

  const update = Effect.fnUntraced(function* (value: {
    readonly generation: McpAppGeneration;
    readonly tooling?: McpToolingCatalog;
    readonly session?: true;
  }) {
    const generation = value.generation;
    const tooling = value.tooling ?? snapshot.tooling;
    const selected =
      value.session === true || generation.key === input.sessionKey ? generation : snapshot.selected;
    const announced: { added: string[]; changed: string[] } = { added: [], changed: [] };
    const changed = new Set<string>();
    const toolingIds = new Set([
      ...tooling.entries.map((entry) => entry.spec.id),
      ...tooling.unavailable.map((entry) => entry.commandId),
    ]);
    if (!projected.has(generation) || tooling.revision !== snapshot.tooling.revision) {
      projected.add(generation);
      for (const [toolId, slots] of variants) if (slots.delete(generation.key)) changed.add(toolId);
      for (const entry of generationEntries(generation, new Set([...sessionIds, ...toolingIds]))) {
        if (!authorized(entry)) continue;
        setVariant(entry.spec.id, generation.key, makeToolVariant(entry, generation.key));
        changed.add(entry.spec.id);
      }
    }
    if (tooling.revision !== snapshot.tooling.revision) {
      for (const entry of snapshot.tooling.entries) {
        variants.get(entry.spec.id)?.delete(SESSION_VARIANT);
        changed.add(entry.spec.id);
      }
      for (const entry of tooling.entries) {
        if (!authorized(entry)) continue;
        setVariant(entry.spec.id, SESSION_VARIANT, makeToolVariant(entry, undefined));
        changed.add(entry.spec.id);
      }
    }
    for (const toolId of [...changed].sort(byId)) {
      const kind = yield* publishTool(toolId);
      if (kind !== undefined) announced[kind].push(toolId);
    }
    const records = [
      ...tooling.unavailable.filter((record) => isMcpToolingAuthorized(input.policy, record.commandId)),
      ...(selected === undefined
        ? []
        : pluginDiagnostics(selected, input.policy).filter((record) => !toolingIds.has(record.commandId))),
    ];
    const next = boundDiagnostics(snapshot.revision, records, input.redactor);
    const revision =
      snapshot.revision +
      (announced.added.length > 0 ||
      announced.changed.length > 0 ||
      JSON.stringify(next) !== JSON.stringify(snapshot.diagnostics)
        ? 1
        : 0);
    snapshot = Object.freeze({
      revision,
      tooling,
      selected,
      advertised: new Map(published),
      diagnostics: Object.freeze({ ...next, revision }),
    });
    if (announced.added.length > 0 || announced.changed.length > 0)
      yield* input.server.notifications["notifications/tools/list_changed"]({});
    return { ...value, publication: announced, diagnostics: snapshot.diagnostics };
  });

  const refresh = <E, R>(
    load: Effect.Effect<
      {
        readonly generation: McpAppGeneration;
        readonly tooling?: McpToolingCatalog;
        readonly session?: true;
      },
      E,
      R
    >,
  ) =>
    publication.withPermits(1)(Effect.flatMap(load, (value) => update(value).pipe(Effect.uninterruptible)));

  return {
    /** Contracts currently advertised for `toolId`. */
    advertised: (toolId: string): ReadonlySet<string> => snapshot.advertised.get(toolId) ?? new Set<string>(),
    refresh,
    toolingOwner: (toolId: string) => snapshot.tooling.entries.find((entry) => entry.spec.id === toolId),
    /** Identity of the contract a selected owner would advertise. */
    signatureOf: (entry: McpCommandEntry, appKey: string): string => {
      const known = signatures.get(entry);
      if (known !== undefined) return known;
      const signature = makeToolVariant(entry, appKey).signature;
      signatures.set(entry, signature);
      return signature;
    },
    /** Publish every tool whose contract is not yet advertised. */
    publishAll: publication.withPermits(1)(
      Effect.forEach([...variants.keys()].sort(byId), publishTool, { discard: true }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            snapshot = Object.freeze({
              ...snapshot,
              advertised: new Map(published),
            });
          }),
        ),
      ),
    ),
    project: (generation: McpAppGeneration) =>
      refresh(Effect.succeed({ generation })).pipe(Effect.map((value) => value.publication)),
  };
});
