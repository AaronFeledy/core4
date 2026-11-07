import { expect, test } from "bun:test";
import { FileSyncStartError } from "@lando/sdk/errors";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result } from "effect";
import { requireFileSyncProvider } from "../../src/operations/file-sync-acquire.ts";
import { fileSyncBundle, normalizeFileSyncBundle } from "../../src/operations/file-sync-bundle.ts";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { acceleratedPlan } from "./accelerated-start-recovery-support.ts";
import { plan } from "./start-progress-topology-support.ts";

test("ordinary plans need neither an engine nor sessions", async () => {
  expect(await Effect.runPromise(fileSyncBundle(plan))).toEqual({ kind: "ordinary", sessions: [] });
});

test("the executable bundle keeps persisted session bytes and one recorded engine", () => {
  const result = normalizeFileSyncBundle(acceleratedPlan);
  expect(Result.isSuccess(result)).toBe(true);
  if (Result.isSuccess(result) && result.success.kind === "accelerated") {
    expect(result.success.id).toBe("mutagen");
    expect(result.success.sessions).toEqual(acceleratedPlan.fileSync.map(({ session }) => session));
    expect(result.success.sessions[0]).toBe(acceleratedPlan.fileSync[0]?.session);
  }
});

test("mixed, missing, duplicate and orphan sessions fail before acquisition", async () => {
  const first = acceleratedPlan.fileSync[0];
  if (first === undefined) throw new Error("Missing accelerated fixture");
  for (const invalid of [
    { ...acceleratedPlan, fileSync: [] },
    { ...acceleratedPlan, fileSync: [first, first] },
    { ...acceleratedPlan, fileSync: [first, { ...first, engineId: "other" }] },
    {
      ...acceleratedPlan,
      fileSync: [
        { ...first, session: { ...first.session, app: { ...first.session.app, kind: "global" as const } } },
      ],
    },
    { ...plan, fileSync: acceleratedPlan.fileSync },
  ]) {
    const result = await Effect.runPromise(Effect.result(fileSyncBundle(invalid)));
    expect(Result.isFailure(result) && result.failure instanceof FileSyncStartError).toBe(true);
  }
});

test("runtime provider capability disagreement fails without hooks or targets", async () => {
  let calls = 0;
  const resolver = FileSyncResolver.of({
    candidates: [
      {
        id: "mutagen",
        pluginName: "test",
        source: "explicit",
        supports: { platform: ["win32"] },
        capabilities: {
          modes: ["two-way-safe"],
          exclusionPatterns: true,
          remoteAgentDeployment: "none",
          conflictReporting: false,
          progressReporting: false,
        },
      },
    ],
    select: () => Effect.die("Execution must not select"),
    acquire: () => Effect.die("Capability verification must not acquire"),
  });
  const provider = {
    ...TestRuntimeProvider,
    prepareFileSyncTargets: () =>
      Effect.sync(() => {
        calls++;
        return { targets: [] };
      }),
    inspectAppliedFileSync: () => Effect.succeed({ status: "missing" as const }),
  };
  const result = await Effect.runPromise(
    Effect.result(
      Effect.flatMap(fileSyncBundle(acceleratedPlan), (bundle) =>
        requireFileSyncProvider(bundle, provider),
      ).pipe(Effect.provideService(FileSyncResolver, resolver)),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  expect(calls).toBe(0);
});

test.each(["complete", "missing-prepare", "missing-inspect", "missing-capability"] as const)(
  "provider lifecycle verification is descriptor-independent (%s)",
  async (state) => {
    let calls = 0;
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        ...(state === "missing-capability" ? {} : { fileSyncTargets: "prepared-volume" as const }),
      },
      ...(state === "missing-prepare"
        ? {}
        : {
            prepareFileSyncTargets: () =>
              Effect.sync(() => {
                calls++;
                return { targets: [] };
              }),
          }),
      ...(state === "missing-inspect"
        ? {}
        : {
            inspectAppliedFileSync: () =>
              Effect.sync(() => {
                calls++;
                return { status: "missing" as const };
              }),
          }),
    };
    const result = await Effect.runPromise(
      Effect.result(
        Effect.flatMap(fileSyncBundle(acceleratedPlan), (bundle) =>
          requireFileSyncProvider(bundle, provider),
        ),
      ),
    );
    expect(Result.isSuccess(result)).toBe(state === "complete");
    expect(calls).toBe(0);
  },
);
