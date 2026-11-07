import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type AppPlan, FileSyncSessionRef } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect } from "effect";
import { prepareDestroyFileSync } from "../../src/operations/destroy-file-sync.ts";
import { normalizeFileSyncBundle } from "../../src/operations/file-sync-bundle.ts";
import { hasCompleteFileSyncCoverage } from "../../src/operations/file-sync-plan.ts";
import { infoForPlan } from "../../src/operations/info.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test("operation coverage and info accept retained session roots and sources through a historical alias", async () => {
  // Given a canonical plan whose original session bytes retain a symlink alias.
  const directory = await mkdtemp(join(tmpdir(), "lando-sync-alias-"));
  try {
    const root = AbsolutePath.make(join(directory, "canonical"));
    const alias = AbsolutePath.make(join(directory, "legacy"));
    await mkdir(root);
    await symlink(root, alias);
    const retained: AppPlan = {
      ...acceleratedPlan,
      root,
      services: Object.fromEntries(
        Object.entries(acceleratedPlan.services).map(([name, service]) => [
          name,
          {
            ...service,
            mounts: service.mounts.map((mount) =>
              mount.type === "bind" ? { ...mount, source: root } : mount,
            ),
          },
        ]),
      ),
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        session: {
          ...entry.session,
          app: { ...entry.session.app, root: alias },
          source: alias,
        },
      })),
    };
    const original = JSON.stringify(retained.fileSync);
    const calls: string[] = [];
    const harness = makeHarness({
      plannedApp: retained,
      appliedFileSyncState: "accelerated",
      fileSync: {
        ...TestFileSyncEngine,
        id: "mutagen",
        isAvailable: Effect.succeed(true),
        listSessions: () =>
          Effect.succeed(
            retained.fileSync.map(({ session }) => ({
              app: session.app,
              service: session.service,
              mountKey: session.mountKey,
              ref: FileSyncSessionRef.make("legacy-session"),
              spec: session,
              status: "running" as const,
              lastUpdatedAt: DateTime.makeUnsafe(0),
            })),
          ),
        flushSession: () =>
          Effect.sync(() => {
            calls.push("flush");
          }),
        terminateSession: () =>
          Effect.sync(() => {
            calls.push("terminate");
          }),
      },
    });
    // When lifecycle coverage and info inspect the recorded plan.
    const bundle = normalizeFileSyncBundle(retained);
    const coverage = hasCompleteFileSyncCoverage(retained);
    const info = await Effect.runPromise(infoForPlan(retained).pipe(Effect.provide(harness.layer)));
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        const provider = yield* registry.select(retained);
        const disposal = yield* prepareDestroyFileSync(
          { plan: retained, root, app: { kind: "user", id: retained.id, root } },
          provider,
        );
        yield* disposal.dispose;
      }).pipe(Effect.provide(harness.layer)),
    );
    // Then historical aliases are accepted without rewriting persisted session inputs.
    expect(bundle._tag).toBe("Success");
    expect(coverage).toBe(true);
    expect(info.fileSync?.applied?.mode).toBe("accelerated");
    expect(calls).toEqual(["flush", "terminate"]);
    expect(JSON.stringify(retained.fileSync)).toBe(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
