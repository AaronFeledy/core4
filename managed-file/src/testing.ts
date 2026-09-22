// In-memory `ManagedFileService` test double. It shares the real decision
// algorithm (`makeManagedFileService`) but binds an in-memory backend, so unit
// tests and CLI suites exercise create/update/skip/conflict/
// adopt/release/remove, marker round-trips, and `block` idempotency with no real
// disk. Files and ledger entries are inspectable.

import { isAbsolute, relative, resolve, sep } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";
import { ManagedFileService } from "@lando/sdk/services";

import type { LandoEvent } from "@lando/sdk/services";

import {
  type LedgerEntry,
  type ManagedFileBackend,
  type ManagedFileEvents,
  ManagedFileServiceFactory,
  makeManagedFileService,
  makeManagedFileServiceFactory,
} from "./service.ts";

export interface TestManagedFileStore {
  /** The `ManagedFileService` implementation backed by memory. */
  readonly service: Context.Tag.Service<typeof ManagedFileService>;
  readonly factory: Context.Tag.Service<typeof ManagedFileServiceFactory>;
  readonly layer: Layer.Layer<ManagedFileService | ManagedFileServiceFactory>;
  /** The resolved base (app root) the store operates against. */
  readonly base: string;
  /** Read a tracked file by path relative to `base`, or `null` when absent. */
  readonly read: (relPath: string) => string | null;
  /** Seed a pre-existing user file (no ownership marker). */
  readonly seed: (relPath: string, content: string) => void;
  /** Snapshot of the current ledger entries. */
  readonly ledger: (base?: string) => ReadonlyArray<LedgerEntry>;
  /** Redacted `ManagedFile` lifecycle events published since construction. */
  readonly events: () => ReadonlyArray<LandoEvent>;
}

/** Build an in-memory `ManagedFileService` for tests. */
export const makeTestManagedFileStore = (
  options: { readonly base?: string; readonly redactText?: (text: string) => string } = {},
): Effect.Effect<TestManagedFileStore> =>
  Effect.gen(function* () {
    const base = options.base ?? "/lando-memfs/app";
    const files = new Map<string, string>();
    const ledgers = new Map<string, ReadonlyArray<LedgerEntry>>();
    const published: Array<LandoEvent> = [];
    const eventSink: ManagedFileEvents = {
      redactText: options.redactText ?? ((text) => text),
      publish: (event) => Effect.sync(() => void published.push(event)),
    };

    const contain = (root: string, relPath: string): string | null => {
      if (isAbsolute(relPath)) return null;
      const target = resolve(root, relPath);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      return target;
    };

    const backend: ManagedFileBackend = {
      resolveBase: (override) => Effect.succeed(override ?? base),
      resolveTarget: (root, relPath, operation) => {
        const abs = contain(root, relPath);
        return abs === null
          ? Effect.fail(
              new ManagedFileError({
                reason: "path",
                operation,
                path: relPath,
                remediation: "Managed-file paths must stay inside the resolved base (app root).",
              }),
            )
          : Effect.succeed(abs);
      },
      readMaybe: (abs) => Effect.succeed(files.get(abs) ?? null),
      writeAtomic: (abs, content) => Effect.sync(() => void files.set(abs, content)),
      removeFile: (abs) => Effect.sync(() => void files.delete(abs)),
      peekLedger: (_operation, ledgerBase) => Effect.succeed(ledgers.get(ledgerBase ?? base) ?? []),
      mutateLedger: (_operation, f, ledgerBase) => {
        const key = ledgerBase ?? base;
        return f(ledgers.get(key) ?? []).pipe(
          Effect.map(([result, next]) => {
            ledgers.set(key, next);
            return result;
          }),
        );
      },
    };

    const service = yield* makeManagedFileService(backend, eventSink);
    const factory = yield* makeManagedFileServiceFactory(backend, eventSink);

    return {
      service,
      factory,
      layer: Layer.merge(
        Layer.succeed(ManagedFileService, service),
        Layer.succeed(ManagedFileServiceFactory, factory),
      ),
      base,
      read: (relPath) => {
        const abs = contain(base, relPath);
        return abs === null ? null : (files.get(abs) ?? null);
      },
      seed: (relPath, content) => {
        const abs = contain(base, relPath);
        if (abs !== null) files.set(abs, content);
      },
      ledger: (ledgerBase) => ledgers.get(ledgerBase ?? base) ?? [],
      events: () => published,
    } satisfies TestManagedFileStore;
  });
