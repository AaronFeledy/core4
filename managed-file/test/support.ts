import { isAbsolute, relative, resolve, sep } from "node:path";

import { type Context, Effect } from "effect";

import { ManagedFileError } from "@lando/sdk/errors";
import type { ManagedFileService } from "@lando/sdk/services";

import { type LedgerEntry, type ManagedFileBackend, makeManagedFileService } from "../src/service.ts";

export interface TestManagedFileStore {
  readonly service: Context.Tag.Service<typeof ManagedFileService>;
  readonly read: (relPath: string) => string | null;
  readonly seed: (relPath: string, content: string) => void;
  readonly ledger: () => ReadonlyArray<LedgerEntry>;
}

export const makeTestManagedFileStore = (): Effect.Effect<TestManagedFileStore> =>
  Effect.gen(function* () {
    const base = "/lando-managed-file-test/app";
    const files = new Map<string, string>();
    let entries: ReadonlyArray<LedgerEntry> = [];

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
      peekLedger: () => Effect.succeed(entries),
      mutateLedger: (_operation, mutate) =>
        mutate(entries).pipe(
          Effect.map(([result, next]) => {
            entries = next;
            return result;
          }),
        ),
    };

    const service = yield* makeManagedFileService(backend);

    return {
      service,
      read: (relPath) => {
        const abs = contain(base, relPath);
        return abs === null ? null : (files.get(abs) ?? null);
      },
      seed: (relPath, content) => {
        const abs = contain(base, relPath);
        if (abs !== null) files.set(abs, content);
      },
      ledger: () => entries,
    } satisfies TestManagedFileStore;
  });
