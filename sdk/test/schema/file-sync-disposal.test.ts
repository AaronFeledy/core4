import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  FileSyncDisposalPhase,
  type FileSyncSessionSpec,
  PortablePath,
  ServiceName,
  fileSyncDisposalCommitted,
  fileSyncDisposalTransitions,
  fileSyncInvalidationRequired,
  planFileSyncDisposal,
} from "@lando/sdk/schema";
import { TestFileSyncEngine, runFileSyncAppLifecycleContract } from "@lando/sdk/test";
import { Effect, Schema } from "effect";

const spec: FileSyncSessionSpec = {
  app: { kind: "user", id: AppId.make("myapp"), root: AbsolutePath.make("/srv/apps/myapp") },
  service: ServiceName.make("web"),
  mountKey: "app",
  source: AbsolutePath.make("/srv/apps/myapp"),
  target: { _tag: "volume", name: "lando-sync-app", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [],
};

const PHASES = FileSyncDisposalPhase.literals;

describe("file sync disposal lifecycle table", () => {
  test("phases are the five documented literals", () => {
    expect(PHASES).toEqual(["absent", "active", "drained", "disposing", "completed"]);
    expect(Schema.is(FileSyncDisposalPhase)("draining")).toBe(false);
  });

  test("the planner lists the operations owed from each phase, resuming where the table re-accepts a phase", () => {
    expect(Object.fromEntries(PHASES.map((phase) => [phase, planFileSyncDisposal(phase)]))).toEqual({
      absent: [],
      active: ["drain", "dispose", "completeDisposal"],
      drained: ["drain", "dispose", "completeDisposal"],
      disposing: ["dispose", "completeDisposal"],
      completed: [],
    });
  });

  test("running a plan walks Advance edges only and ends completed (or stays absent)", () => {
    for (const phase of PHASES) {
      let current = phase;
      for (const operation of planFileSyncDisposal(phase)) {
        const verdict = fileSyncDisposalTransitions.step(operation, current);
        expect(verdict._tag).toBe("Advance");
        if (verdict._tag === "Advance") current = verdict.to;
      }
      expect(current).toBe(phase === "absent" ? "absent" : "completed");
    }
  });

  test("disposal is committed once disposing or completed", () => {
    expect(PHASES.filter(fileSyncDisposalCommitted)).toEqual(["disposing", "completed"]);
  });

  test("a start invalidates unless the app owns nothing and the table settles the phase", () => {
    expect(
      Object.fromEntries(PHASES.map((phase) => [phase, fileSyncInvalidationRequired(phase, false)])),
    ).toEqual({ absent: false, active: true, drained: true, disposing: true, completed: false });
    for (const phase of PHASES) expect(fileSyncInvalidationRequired(phase, true)).toBe(true);
  });

  test("createSession is the only way back from completed", () => {
    const returning = Object.entries(fileSyncDisposalTransitions.edges)
      .filter(
        ([, edge]) => edge.from.includes("completed") && edge.to !== undefined && edge.to !== "completed",
      )
      .map(([operation]) => operation);
    expect(returning).toEqual(["createSession"]);
  });

  test("the lifecycle contract has nothing to hold an engine without appLifecycle to", async () => {
    await Effect.runPromise(runFileSyncAppLifecycleContract({ ...TestFileSyncEngine }, spec));
  });
});
