/**
 * The session's published tool catalog.
 *
 * One catalog per session holds the authorized owner variants of every tool id from every
 * discovered app; there is no mutable "current app". A generation built for a new app root is
 * projected once: its authorized plugin owners replace that app's previous variants, and every
 * tool whose union contract changed is upserted on the server, which announces
 * `notifications/tools/list_changed`. Tools are never removed here (whole-catalog replacement is
 * a separate concern).
 */
import { Context, Effect, Semaphore } from "effect";
import type * as McpServer from "effect/ai/McpServer";

import { type McpAppGeneration, generationEntries } from "./apps";
import { type McpAllowPolicy, isMcpEntryAuthorized } from "./catalog";
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

const sameSignatures = (left: ReadonlySet<string> | undefined, right: ReadonlySet<string>): boolean =>
  left !== undefined && left.size === right.size && [...right].every((signature) => left.has(signature));

const byId = (left: string, right: string) => left.localeCompare(right);

export const makeSessionCatalog = Effect.fnUntraced(function* (input: {
  readonly server: McpServerShape;
  readonly policy: McpAllowPolicy;
  /** Session-wide owners (built-ins and, with tooling on, tooling tasks). */
  readonly entries: ReadonlyArray<McpCommandEntry>;
  readonly handle: (toolId: string) => ToolHandler;
}) {
  const sessionIds = new Set(input.entries.map((entry) => entry.spec.id));
  const variants = new Map<string, Map<string, McpToolVariant>>();
  const published = new Map<string, ReadonlySet<string>>();
  const projected = new WeakSet<McpAppGeneration>();
  const signatures = new WeakMap<McpCommandEntry, string>();
  const publication = yield* Semaphore.make(1);

  const setVariant = (toolId: string, slot: string, variant: McpToolVariant) => {
    const slots = variants.get(toolId) ?? new Map<string, McpToolVariant>();
    slots.set(slot, variant);
    variants.set(toolId, slots);
    signatures.set(variant.entry, variant.signature);
  };

  const publishTool = Effect.fnUntraced(function* (toolId: string) {
    const [first, ...rest] = [...(variants.get(toolId)?.values() ?? [])];
    if (first === undefined) return undefined;
    const union = unionTool(toolId, [first, ...rest]);
    const previous = published.get(toolId);
    if (sameSignatures(previous, union.signatures)) return undefined;
    // Upsert by name; the server announces notifications/tools/list_changed.
    yield* input.server.addTool({
      tool: union.tool,
      annotations: Context.empty(),
      handle: input.handle(toolId),
    });
    published.set(toolId, union.signatures);
    return previous === undefined ? ("added" as const) : ("changed" as const);
  });

  for (const entry of input.entries)
    if (isMcpEntryAuthorized(input.policy, entry))
      setVariant(entry.spec.id, SESSION_VARIANT, makeToolVariant(entry, undefined));

  return {
    /** Contracts currently advertised for `toolId`. */
    advertised: (toolId: string): ReadonlySet<string> => published.get(toolId) ?? new Set<string>(),
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
      Effect.forEach([...variants.keys()].sort(byId), publishTool, { discard: true }),
    ),
    /** Add a newly built generation's authorized owners to the catalog, once per generation. */
    project: (generation: McpAppGeneration) =>
      publication.withPermits(1)(
        Effect.gen(function* () {
          const announced: { added: string[]; changed: string[] } = { added: [], changed: [] };
          if (projected.has(generation)) return announced;
          projected.add(generation);
          const changed = new Set<string>();
          for (const [toolId, slots] of variants) if (slots.delete(generation.key)) changed.add(toolId);
          for (const entry of generationEntries(generation, sessionIds)) {
            if (!isMcpEntryAuthorized(input.policy, entry)) continue;
            setVariant(entry.spec.id, generation.key, makeToolVariant(entry, generation.key));
            changed.add(entry.spec.id);
          }
          for (const toolId of [...changed].sort(byId)) {
            const kind = yield* publishTool(toolId);
            if (kind !== undefined) announced[kind].push(toolId);
          }
          return announced satisfies McpToolPublication;
        }),
      ),
  };
});
