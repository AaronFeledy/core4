import { expect, test } from "bun:test";
import * as BunDataMover from "@lando/data-mover/service";
import { AppsGcReport } from "@lando/engine/operations/apps-gc";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import * as TransactionGuard from "@lando/managed-file/transaction-guard";
import { isMcpDestructiveCommand } from "@lando/mcp/allowlist";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { InteractionService, PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { appsGcConfirmation, appsGcSpec, runAppsGcCommand } from "../../src/cli/command-specs/apps/gc";
import { renderAppsGcReport } from "../../src/cli/commands/apps-gc";
import { makeTestInteractionService } from "../../src/testing/interaction";
import { makeTestRuntime } from "../../src/testing/test-runtime";

const report: AppsGcReport = {
  prune: false,
  scans: [],
  roots: [],
  completedJournalsRemoved: 0,
  unreadableJournals: [],
  candidates: ["/missing/first", "/missing/second"].map((root) => ({
    root: AbsolutePath.make(root),
    apps: [AppId.make("app")],
    providers: [ProviderId.make("lando")],
    appliedState: true,
    runtimeObserved: false,
    services: ["app-web"],
    dataVolumes: ["app-database"],
    cacheVolumes: ["app-cache"],
    journals: [
      {
        attemptId: "attempt",
        appId: "app",
        appRoot: root,
        providerId: "lando",
        engineId: "mutagen",
        mountPlanDigest: "digest",
        phase: "apply-intent" as const,
        targets: [
          { service: "web", mountKey: "code", volumeName: "app-code-copy", helperSpecDigest: "digest" },
        ],
        sessions: [],
      },
    ],
  })),
};
const registry = RuntimeProviderRegistry.of({
  list: Effect.succeed([]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed(TestRuntimeProvider),
  appliedPlansFor: () => Effect.succeed([]),
  resolveAppliedPlan: () => Effect.succeed(undefined),
  resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
  observeRuntime: Effect.succeed([]),
});
const baseLayer = Layer.mergeAll(
  makeTestRuntime({ bootstrap: "app" }).layer,
  Layer.succeed(RedactionService, makeRedactionService()),
  Layer.succeed(PathsService, makeLandoPaths()),
  BunFileSystem.layer,
  makeTestStateStore().layer,
  Layer.succeed(RuntimeProviderRegistry, registry),
);
const layer = Layer.mergeAll(
  baseLayer,
  TransactionGuard.layer,
  BunDataMover.layer.pipe(Layer.provide(baseLayer)),
);

test("apps:gc report is schema-valid and runs without confirmation", async () => {
  const result = await Effect.runPromise(runAppsGcCommand({ flags: {} }).pipe(Effect.provide(layer)));
  expect(Schema.is(AppsGcReport)(result)).toBe(true);
  expect(result).toMatchObject({ prune: false, candidates: [], roots: [] });
});

test("apps:gc prune fails non-interactively without --yes", async () => {
  const result = await Effect.runPromise(
    runAppsGcCommand({ flags: { prune: true } }).pipe(Effect.provide(layer), Effect.result),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "CommandConfirmationError", reason: "non-interactive" },
  });
});

test("apps:gc asks one confirmation and sweeps after it is accepted", async () => {
  const interaction = makeTestInteractionService({ answers: { confirm: "true" } });
  const result = await Effect.runPromise(
    runAppsGcCommand({ flags: { prune: true } }).pipe(
      Effect.provideService(InteractionService, {
        ...interaction.service,
        isInteractive: Effect.succeed(true),
      }),
      Effect.provide(layer),
    ),
  );
  expect(result.prune).toBe(true);
  expect(interaction.transcript()).toHaveLength(1);
});

test.each([false, true])(
  "batch confirmation names all roots and file-sync data loss with volumes=%s",
  (volumes) => {
    const message = appsGcConfirmation(report, { volumes, purgeCaches: false, purgeSnapshots: false });
    expect(message).toContain("/missing/first");
    expect(message).toContain("/missing/second");
    expect(message).toContain(
      volumes
        ? "Delete containers, data volumes and file-sync copies of app files"
        : "Keep data volumes and file-sync copies of app files",
    );
    expect(message).toContain("cache volumes");
    expect(message).toContain("snapshots");
    expect(message).toContain("app-web");
    expect(message).toContain("app-database");
    expect(message).toContain("app-cache");
    expect(message).toContain("not inventoried");
    expect(message).toContain(`${volumes ? "Delete" : "Keep"} data volumes: app-database`);
    expect(message).toContain(`${volumes ? "Delete" : "Keep"} file-sync copies: app-code-copy`);
    expect(message).toContain("Keep cache volumes: app-cache");
    expect(message).toContain("live holdings are unknown");
  },
);

test("apps:gc retains its batch result and exits nonzero when a confirmed root did not complete", () => {
  for (const outcome of ["failed", "retained"] as const) {
    expect(
      appsGcSpec.completion?.(
        {
          ...report,
          prune: true,
          roots: [
            {
              root: AbsolutePath.make("/missing"),
              providers: [],
              confirmed: true,
              outcome,
              reason: "incomplete",
            },
          ],
        },
        undefined,
      ),
    ).toEqual({ ok: false, exitCode: 1 });
  }
  expect(appsGcSpec.completion?.(report, undefined)).toEqual({ ok: true, exitCode: 0 });
});

test("apps:gc is destructive and does not self-allow MCP or claim a top-level alias", () => {
  expect(isMcpDestructiveCommand(appsGcSpec)).toBe(true);
  expect(appsGcSpec.mcpAllowed).not.toBe(true);
  expect(appsGcSpec.topLevelAlias).toBeUndefined();
});

test.each([false, true])(
  "plain prune succeeds with kept data; requested but withheld volume cleanup fails: %s",
  async (volumes) => {
    const providerId = ProviderId.make("test");
    const root = AbsolutePath.make("/missing/retained-data");
    const result = await Effect.runPromise(
      runAppsGcCommand({ flags: { prune: true, yes: true, volumes } }).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...registry,
          list: Effect.succeed([providerId]),
          observeRuntime: Effect.succeed([
            {
              providerId,
              runtimeObserved: true,
              appliedPlans: [],
              services: [],
              volumes: [
                {
                  ref: { app: AppId.make("kept"), store: "database" },
                  identity: {
                    nativeName: "kept-data",
                    coordinationKey: "key",
                    generation: "1",
                    ownerRoot: root,
                    origin: "created" as const,
                  },
                },
              ],
            },
          ]),
        }),
        Effect.provide(layer),
      ),
    );
    expect(appsGcSpec.completion?.(result, undefined)).toEqual({ ok: !volumes, exitCode: volumes ? 1 : 0 });
    const output = renderAppsGcReport(result);
    if (!volumes) {
      expect(output).toContain("kept-data");
      expect(output).toContain("because --volumes was not set");
    } else expect(output).toContain("Requested cleanup is incomplete");
  },
);

test("GC text reports unreadable journal paths, tagged errors and remediation", () => {
  const output = renderAppsGcReport({
    ...report,
    unreadableJournals: [
      {
        path: "/state/broken.json",
        _tag: "StateStoreError",
        message: "Cannot decode journal",
        remediation: "Preserve this journal.",
      },
    ],
  });
  expect(output).toContain(
    "/state/broken.json: StateStoreError: Cannot decode journal Preserve this journal.",
  );
});
