import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostMaintenanceContribution } from "@lando/sdk/plugins";
import { HostChangeId, type HostUninstallStep, UninstallStepResult } from "@lando/sdk/schema";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer, Result, Schema } from "effect";
import { uninstall } from "../../src/operations/uninstall.ts";
import {
  UninstallContributionConflictError,
  contributedStepId,
  contributionBlocksUserDataRoot,
  planHostUninstallContributions,
} from "../../src/operations/uninstall-contributions.ts";
import { HostMaintenanceRegistry } from "../../src/runtime/host-maintenance.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

const runUninstall = (
  options: Parameters<typeof uninstall>[0],
  maintainers: ReadonlyArray<HostMaintenanceContribution> = [],
) =>
  uninstall(options).pipe(
    Effect.provide(PrivateFileAccessService.layer),
    Effect.provide(
      Layer.succeed(
        HostMaintenanceRegistry,
        HostMaintenanceRegistry.of({
          maintainers: maintainers.map((maintainer) => ({ ...maintainer, pluginId: "@lando/test" })),
        }),
      ),
    ),
  );

const ownedStep = (id: string, overrides: Partial<HostUninstallStep> = {}): HostUninstallStep => ({
  id,
  label: id,
  target: `/tmp/${id}`,
  destructive: true,
  status: "owned",
  detail: `remove ${id}`,
  ...overrides,
});

describe("host uninstall contributions", () => {
  test("contributionBlocksUserDataRoot treats any non-completed owned outcome as blocking", () => {
    expect(contributionBlocksUserDataRoot("owned", "completed")).toBe(false);
    expect(contributionBlocksUserDataRoot("owned", "failed")).toBe(true);
    expect(contributionBlocksUserDataRoot("owned", "manual")).toBe(true);
    expect(contributionBlocksUserDataRoot("owned", "skipped")).toBe(true);
    expect(contributionBlocksUserDataRoot("skipped", "skipped")).toBe(false);
    expect(contributionBlocksUserDataRoot("manual", "manual")).toBe(false);
  });

  test("plans composite maintainer:local ids after running-apps and before global-app-state", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-order-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files", { preserveOnKeepData: true })]),
          execute: () => Effect.succeed({ outcome: "completed" }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { dryRun: true, purge: true }), [maintainer]),
      );
      const ids = result.steps.map((step) => step.id);
      const contributionId = contributedStepId("fake-helper", "unit-files");
      expect(ids).toContain(contributionId);
      expect(ids.indexOf("running-apps")).toBeLessThan(ids.indexOf(contributionId));
      expect(ids.indexOf(contributionId)).toBeLessThan(ids.indexOf("global-app-state"));
      expect(ids.indexOf(contributionId)).toBeLessThan(ids.indexOf("user-data-root"));
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("preserveOnKeepData skips without calling execute", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-keep-");
    let executeCalls = 0;
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files", { preserveOnKeepData: true })]),
          execute: () => {
            executeCalls += 1;
            return Effect.succeed({ outcome: "completed" });
          },
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, keepData: true }), [maintainer]),
      );
      const step = result.steps.find((entry) => entry.id === contributedStepId("fake-helper", "unit-files"));
      expect(step).toMatchObject({ status: "skipped", outcome: "skipped" });
      expect(executeCalls).toBe(0);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("a recorded change is listed under the id --undo takes, and --keep-data keeps it even when named", async () => {
    // Given a maintainer step that undoes a recorded, separately approved change.
    const receiptId = HostChangeId.make("test-ca:trust-system-store");
    const change = {
      id: receiptId,
      owner: "@lando/test",
      stage: "ca",
      summary: "Remove the anchor",
      reason: "Undo what setup recorded.",
      consent: "separate",
      persistent: false,
      requirement: "recommended",
      steps: [
        { id: "rm", summary: "rm", argv: ["/usr/bin/rm", "-f", "/etc/x"], privileged: true, when: "always" },
      ],
      undo: { _tag: "none", detail: "Nothing." },
    } as const;
    const maintainer = {
      id: "test-ca",
      pluginId: "@lando/test",
      uninstall: {
        plan: () =>
          Effect.succeed([
            ownedStep("anchor", {
              receiptId,
              change,
              preserveOnKeepData: true,
              detail: "Remove the anchor.",
            }),
          ]),
        execute: () => Effect.succeed({ outcome: "completed" as const }),
      },
    };
    const receipts = [
      {
        id: receiptId,
        owner: "@lando/test",
        summary: "Trust the CA",
        phase: "applied",
        startedAt: "2026-11-26T00:00:00.000Z",
        undo: { _tag: "steps", consent: "separate", summary: "Remove the anchor", steps: change.steps },
      } as const,
    ];
    const plan = (mode: "keep-data" | "purge") =>
      Effect.runPromise(
        planHostUninstallContributions(
          { maintainers: [maintainer] },
          { platform: "linux", userDataRoot: "/tmp/data", mode, receipts, undo: ["all"] },
        ),
      );

    // When it is planned with --undo all under each mode.
    const [kept] = (await plan("keep-data")).steps;
    const [undone] = (await plan("purge")).steps;

    // Then both list it as the receipt's id; only --purge undoes it.
    expect(kept).toMatchObject({ id: "test-ca:trust-system-store", status: "skipped" });
    expect(kept?.detail).toContain("`--purge --undo test-ca:trust-system-store`");
    expect(undone).toMatchObject({ id: "test-ca:trust-system-store", status: "owned" });
    expect(undone?.detail).toContain("`--undo` named `test-ca:trust-system-store`");
  });

  test("executes owned contributions without generic remove of the step target", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-exec-");
    const marker = join(roots.root, "marker");
    const removed: string[] = [];
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      writeFileSync(marker, "keep");
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () =>
            Effect.succeed([
              ownedStep("unit-files", {
                target: marker,
                detail: "owned marker",
              }),
            ]),
          execute: () => {
            // Contribution owns mutation; generic remove must not touch the target.
            return Effect.succeed({ outcome: "completed" });
          },
        },
      };
      const result = await Effect.runPromise(
        runUninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            remove: async (path) => {
              removed.push(path);
            },
          }),
          [maintainer],
        ),
      );
      expect(result.steps.find((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toMatchObject(
        {
          outcome: "completed",
        },
      );
      expect(removed).not.toContain(marker);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("runs a step's declared change through the uninstall's session, and nothing else", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-run-");
    const elevated: Array<ReadonlyArray<string>> = [];
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      const change = {
        id: HostChangeId.make("test:remove-units"),
        owner: "@lando/test",
        stage: "proxy",
        summary: "Remove the units",
        reason: "Tests.",
        consent: "standard",
        persistent: false,
        requirement: "recommended",
        steps: [
          {
            id: "remove",
            summary: "remove",
            argv: ["/bin/true", "remove"],
            privileged: true,
            when: "always",
          },
        ],
        undo: { _tag: "none", detail: "none" },
      } as const;
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files", { change })]),
          execute: ({ run }) =>
            Effect.gen(function* () {
              if (run === undefined) return { outcome: "failed" as const, error: "missing runner" };
              const undeclared = yield* Effect.result(run.run("other"));
              const declared = yield* Effect.result(run.run("remove"));
              return undeclared._tag === "Failure" && declared._tag === "Success"
                ? { outcome: "completed" as const }
                : { outcome: "failed" as const, error: "the runner ran an undeclared step" };
            }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            elevate: async (command) => {
              elevated.push(command);
              return { exitCode: 0, stdout: "", stderr: "" };
            },
          }),
          [maintainer],
        ),
      );
      expect(result.failed).toBe(false);
      expect(elevated).toEqual([["/bin/true", "remove"]]);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("owned contribution failure blocks user-data-root deletion", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-block-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      writeFileSync(join(roots.userDataRoot, "evidence.txt"), "keep-me");
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files")]),
          execute: () => Effect.succeed({ outcome: "failed", error: "helper refused" }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [maintainer]),
      );
      expect(result.failed).toBe(true);
      expect(result.steps.find((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toMatchObject(
        {
          outcome: "failed",
        },
      );
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        status: "owned",
        outcome: "failed",
      });
      expect(existsSync(join(roots.userDataRoot, "evidence.txt"))).toBe(true);
      expect(result.reportPath).toBeDefined();
      const report = Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Struct({ status: Schema.Literal("failed"), steps: Schema.Array(UninstallStepResult) }),
        ),
      )(readFileSync(join(roots.userDataRoot, "uninstall", "report.json"), "utf8"));
      expect(result.steps).toEqual(report.steps);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("ownership loss on an originally owned contribution blocks user-data-root deletion", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-loss-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      writeFileSync(join(roots.userDataRoot, "evidence.txt"), "keep-me");
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files")]),
          execute: () =>
            Effect.succeed({
              outcome: "manual",
              detail: "no longer owned",
              status: "user-owned",
              id: "foreign",
            }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [maintainer]),
      );
      expect(result.failed).toBe(true);
      expect(result.reportPath).toBeDefined();
      expect(result.steps.find((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toMatchObject(
        {
          status: "owned",
          outcome: "manual",
        },
      );
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        status: "owned",
        outcome: "failed",
      });
      expect(existsSync(join(roots.userDataRoot, "evidence.txt"))).toBe(true);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("rejects reserved built-in step ids before execution", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-reserved-");
    let executeCalls = 0;
    try {
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("runtime-service")]),
          execute: () => {
            executeCalls += 1;
            return Effect.succeed({ outcome: "completed" });
          },
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [maintainer]),
      );
      expect(result.failed).toBe(true);
      expect(result.steps[0]?.id).toBe("host-maintenance-contributions");
      expect(result.steps[0]?.error).toContain("reserved");
      expect(executeCalls).toBe(0);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate composite step ids before execution", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-dup-");
    try {
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files"), ownedStep("unit-files")]),
          execute: () => Effect.succeed({ outcome: "completed" }),
        },
      };
      const planned = await Effect.runPromise(
        Effect.result(
          planHostUninstallContributions(
            { maintainers: [{ ...maintainer, pluginId: "@lando/test" }] },
            { platform: "linux", userDataRoot: roots.userDataRoot, mode: "purge", receipts: [], undo: [] },
          ),
        ),
      );
      expect(Result.isFailure(planned)).toBe(true);
      if (Result.isFailure(planned)) {
        expect(planned.failure).toBeInstanceOf(UninstallContributionConflictError);
        expect(planned.failure.reason).toBe("duplicate");
      }
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("skipped outcome on originally owned contribution blocks user-data-root deletion", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-skipped-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      writeFileSync(join(roots.userDataRoot, "evidence.txt"), "keep-me");
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files")]),
          execute: () => Effect.succeed({ outcome: "skipped", detail: "resource gone mid-run" }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [maintainer]),
      );
      expect(result.failed).toBe(true);
      expect(result.reportPath).toBeDefined();
      expect(result.steps.find((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toMatchObject(
        {
          outcome: "skipped",
        },
      );
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        status: "owned",
        outcome: "failed",
      });
      expect(existsSync(join(roots.userDataRoot, "evidence.txt"))).toBe(true);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("install-record purge does not remove a blocked data root with a real install record", async () => {
    // Regression: binaryResolved + install-record purge previously called remove(userDataRoot)
    // even when blockUserDataRoot skipped the earlier user-data-root step, destroying evidence.
    const roots = makeUninstallRoots("lando-uninstall-contrib-record-block-");
    const binary = join(roots.root, "external", "lando4");
    const record = join(roots.userDataRoot, "install", "record.json");
    const evidence = join(roots.userDataRoot, "evidence.txt");
    const removed: string[] = [];
    try {
      mkdirSync(join(roots.root, "external"), { recursive: true });
      mkdirSync(join(roots.userDataRoot, "install"), { recursive: true });
      writeFileSync(binary, "v4 executable", { mode: 0o755 });
      writeFileSync(evidence, "keep-me");
      const bytes = readFileSync(binary);
      writeFileSync(
        record,
        JSON.stringify({
          version: 1,
          data: {
            executable: {
              path: binary,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
              channel: "stable",
              platform: "linux-x64",
              releaseVersion: "4.2.0",
            },
            shellProfiles: [],
          },
        }),
      );
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files")]),
          execute: () => Effect.succeed({ outcome: "manual", detail: "no longer owned" }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            remove: async (path) => {
              removed.push(path);
              // Still delete non-root targets so install-record/binary cleanup can proceed.
              if (path !== roots.userDataRoot) {
                rmSync(path, { recursive: true, force: true });
              }
            },
          }),
          [maintainer],
        ),
      );
      expect(result.failed).toBe(true);
      expect(result.reportPath).toBeDefined();
      expect(removed).not.toContain(roots.userDataRoot);
      expect(existsSync(evidence)).toBe(true);
      expect(existsSync(roots.userDataRoot)).toBe(true);
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        status: "owned",
        outcome: "failed",
      });
      expect(result.steps.find((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toMatchObject(
        {
          outcome: "manual",
        },
      );
      // Install record may still retire once binary/shell cleanup resolved; root must remain.
      expect(existsSync(record)).toBe(false);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("owned contribution failure with a real install record still blocks install-record root purge", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-record-fail-");
    const binary = join(roots.root, "external", "lando4");
    const record = join(roots.userDataRoot, "install", "record.json");
    const evidence = join(roots.userDataRoot, "evidence.txt");
    const removed: string[] = [];
    try {
      mkdirSync(join(roots.root, "external"), { recursive: true });
      mkdirSync(join(roots.userDataRoot, "install"), { recursive: true });
      writeFileSync(binary, "v4 executable", { mode: 0o755 });
      writeFileSync(evidence, "keep-me");
      const bytes = readFileSync(binary);
      writeFileSync(
        record,
        JSON.stringify({
          version: 1,
          data: {
            executable: {
              path: binary,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              size: bytes.length,
              channel: "stable",
              platform: "linux-x64",
              releaseVersion: "4.2.0",
            },
            shellProfiles: [],
          },
        }),
      );
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-files")]),
          execute: () => Effect.succeed({ outcome: "failed", error: "helper refused" }),
        },
      };
      const result = await Effect.runPromise(
        runUninstall(
          sandboxUninstallOptions(roots, {
            yes: true,
            purge: true,
            remove: async (path) => {
              removed.push(path);
              if (path !== roots.userDataRoot) {
                rmSync(path, { recursive: true, force: true });
              }
            },
          }),
          [maintainer],
        ),
      );
      expect(result.failed).toBe(true);
      expect(result.reportPath).toBeDefined();
      expect(removed).not.toContain(roots.userDataRoot);
      expect(existsSync(evidence)).toBe(true);
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        outcome: "failed",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("blockUserDataRoot is monotonic across contribution catch paths", async () => {
    // Catch previously assigned blockUserDataRoot = (status === "owned"), which could
    // clear a prior true when a later step was not owned. Drive an owned failure then an
    // owned throw; root must stay blocked. Unit-level monotonic OR is also covered by
    // contributionBlocksUserDataRoot semantics under multi-step execution.
    const roots = makeUninstallRoots("lando-uninstall-contrib-monotonic-");
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      writeFileSync(join(roots.userDataRoot, "evidence.txt"), "keep-me");
      const first: HostMaintenanceContribution = {
        id: "first-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-a")]),
          execute: () => Effect.succeed({ outcome: "failed", error: "first failed" }),
        },
      };
      const second: HostMaintenanceContribution = {
        id: "second-helper",
        uninstall: {
          plan: () => Effect.succeed([ownedStep("unit-b")]),
          execute: () => {
            throw new Error("second blew up");
          },
        },
      };
      const result = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [first, second]),
      );
      expect(result.failed).toBe(true);
      expect(result.reportPath).toBeDefined();
      expect(existsSync(join(roots.userDataRoot, "evidence.txt"))).toBe(true);
      expect(result.steps.find((s) => s.id === "user-data-root")).toMatchObject({
        outcome: "failed",
      });
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });

  test("dry-run and execution use the same registry contributions", async () => {
    const roots = makeUninstallRoots("lando-uninstall-contrib-same-reg-");
    const planCalls: string[] = [];
    try {
      mkdirSync(roots.userDataRoot, { recursive: true });
      const maintainer: HostMaintenanceContribution = {
        id: "fake-helper",
        uninstall: {
          plan: ({ userDataRoot }) => {
            planCalls.push(userDataRoot);
            return Effect.succeed([ownedStep("unit-files")]);
          },
          execute: () => Effect.succeed({ outcome: "completed" }),
        },
      };
      const dry = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { dryRun: true, purge: true }), [maintainer]),
      );
      const live = await Effect.runPromise(
        runUninstall(sandboxUninstallOptions(roots, { yes: true, purge: true }), [maintainer]),
      );
      expect(dry.steps.some((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toBe(true);
      expect(live.steps.some((s) => s.id === contributedStepId("fake-helper", "unit-files"))).toBe(true);
      expect(planCalls).toEqual([roots.userDataRoot, roots.userDataRoot]);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  });
});
