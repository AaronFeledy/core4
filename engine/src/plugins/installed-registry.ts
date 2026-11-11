import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { illegalTransitionMessage, planTransition } from "@lando/sdk/transitions";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Effect, Predicate, Result, Schema } from "effect";
import { withPluginMutationLock } from "./mutation-lock.ts";
import {
  type InstalledPluginRegistryMutation,
  installedPluginRegistryState,
  installedPluginRegistryTransitions,
  planInstalledPluginRegistryWrite,
} from "./registry-transitions.ts";

export {
  type InstalledPluginRegistryRejection,
  isInstalledPluginRegistryRejection,
  planInstalledPluginRegistryWrite,
} from "./registry-transitions.ts";

export interface InstalledPluginRegistryEntry {
  readonly name: string;
  readonly version: string;
  readonly path: string;
  readonly requestedSelector?: string | undefined;
  readonly source?: "installed" | "linked" | undefined;
  readonly linkedPath?: string | undefined;
}

export type InstalledPluginRegistry = Readonly<Record<string, InstalledPluginRegistryEntry>>;

export interface InstalledPluginRegistryFailure {
  readonly pluginId: string;
  readonly pluginPath: string;
  readonly metadataPath: string;
  readonly cause: unknown;
}

export interface InstalledPluginRegistryInspection {
  readonly registry: InstalledPluginRegistry;
  readonly failures: ReadonlyArray<InstalledPluginRegistryFailure>;
}

type RawInstalledPluginRegistry = Record<string, unknown>;

const InstalledPluginRegistryEntryShape = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  path: Schema.String,
  requestedSelector: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["installed", "linked"])),
  linkedPath: Schema.optionalKey(Schema.String),
});

const installedPluginRegistryPath = (pluginsRoot: string): string => join(pluginsRoot, "registry.json");

const corruptRegistryError = (path: string, cause: unknown): Error =>
  new Error(`Installed plugin registry is corrupt: ${path}. ${String(cause)}`);

const readRawInstalledPluginRegistry = async (pluginsRoot: string): Promise<RawInstalledPluginRegistry> => {
  const path = installedPluginRegistryPath(pluginsRoot);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw corruptRegistryError(path, cause);
  }
  if (!Predicate.isObject(parsed)) throw corruptRegistryError(path, "registry root is not an object");
  return parsed;
};

export const readInstalledPluginRegistry = async (pluginsRoot: string): Promise<InstalledPluginRegistry> => {
  const inspection = await inspectInstalledPluginRegistry(pluginsRoot);
  return inspection.registry;
};

export const inspectInstalledPluginRegistry = async (
  pluginsRoot: string,
): Promise<InstalledPluginRegistryInspection> => {
  const metadataPath = installedPluginRegistryPath(pluginsRoot);
  let raw: RawInstalledPluginRegistry;
  try {
    raw = await readRawInstalledPluginRegistry(pluginsRoot);
  } catch (cause) {
    return {
      registry: {},
      failures: [{ pluginId: "registry", pluginPath: pluginsRoot, metadataPath, cause }],
    };
  }
  const registry: Record<string, InstalledPluginRegistryEntry> = {};
  const failures: InstalledPluginRegistryFailure[] = [];
  for (const [name, entry] of Object.entries(raw)) {
    const decoded = Schema.decodeUnknownResult(InstalledPluginRegistryEntryShape)(entry, {
      onExcessProperty: "error",
    });
    if (Result.isSuccess(decoded)) {
      registry[name] = decoded.success;
    } else {
      failures.push({
        pluginId: name,
        pluginPath: Predicate.isObject(entry) && typeof entry.path === "string" ? entry.path : pluginsRoot,
        metadataPath,
        cause: decoded.failure,
      });
    }
  }
  return { registry, failures };
};

const defaultIo = { writeFileAtomic };

export const mutateInstalledPluginRegistry = <A, E, R>(
  input: {
    readonly pluginsRoot: string;
    readonly mutation: InstalledPluginRegistryMutation;
    readonly onWait?: Effect.Effect<void>;
  },
  use: (commit: () => Promise<void>) => Effect.Effect<A, E, R>,
  io: typeof defaultIo = defaultIo,
) =>
  withPluginMutationLock(
    input.pluginsRoot,
    `plugin:${input.mutation.operation}`,
    Effect.gen(function* () {
      const path = installedPluginRegistryPath(input.pluginsRoot);
      const registry = yield* Effect.promise(() => readRawInstalledPluginRegistry(input.pluginsRoot));
      const snapshot = yield* Effect.promise(async () =>
        existsSync(path) ? readFile(path, "utf8") : undefined,
      );
      const mutation = input.mutation;
      const name = "entry" in mutation ? mutation.entry.name : mutation.name;
      const raw = registry[name];
      const previous =
        raw === undefined ? undefined : Schema.decodeUnknownSync(InstalledPluginRegistryEntryShape)(raw);
      const plan = planInstalledPluginRegistryWrite(mutation, previous);
      const next = { ...registry };
      switch (plan._tag) {
        case "Reject":
          return yield* Effect.fail(plan.cause);
        case "Store":
          next[name] = plan.entry;
          break;
        case "Delete":
          delete next[name];
          break;
        case "Unchanged":
          break;
        default:
          return plan satisfies never;
      }
      const commit = async (): Promise<void> => {
        if (plan._tag === "Unchanged") return;
        try {
          await io.writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
        } catch (cause) {
          try {
            const current = (await readRawInstalledPluginRegistry(input.pluginsRoot))[name];
            const stored =
              current === undefined
                ? undefined
                : Schema.decodeUnknownSync(InstalledPluginRegistryEntryShape)(current);
            const operation = `rollback-${installedPluginRegistryState(previous)}` as const;
            // An atomic writer may reject before or after its rename; either way the
            // prior bytes (or their absence) are restored.
            const rollback = planTransition(
              installedPluginRegistryTransitions,
              operation,
              installedPluginRegistryState(stored),
              () => snapshot ?? null,
            );
            switch (rollback._tag) {
              case "Illegal":
                throw new Error(illegalTransitionMessage("Plugin registry", operation, rollback.verdict));
              case "Keep":
                break;
              case "Write":
                if (rollback.value === null) await rm(path, { force: true });
                else await writeFileAtomic(path, rollback.value);
                break;
            }
          } catch (rollbackCause) {
            throw new AggregateError(
              [cause, rollbackCause],
              "Plugin registry publication and rollback failed.",
            );
          }
          throw cause;
        }
      };
      return yield* use(commit).pipe(Effect.uninterruptible);
    }),
    input.onWait,
  );

export const recordInstalledPlugin = (
  pluginsRoot: string,
  entry: InstalledPluginRegistryEntry,
): Promise<void> =>
  Effect.runPromise(
    mutateInstalledPluginRegistry({ pluginsRoot, mutation: { operation: "install", entry } }, (commit) =>
      Effect.promise(commit),
    ),
  );

export const removeInstalledPlugin = (pluginsRoot: string, name: string): Promise<void> =>
  Effect.runPromise(
    mutateInstalledPluginRegistry({ pluginsRoot, mutation: { operation: "remove", name } }, (commit) =>
      Effect.promise(commit),
    ),
  );
