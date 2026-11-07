import { describe, expect, test } from "bun:test";
import {
  type FileSyncDisposalPhase,
  fileSyncDisposalTransitions,
  planFileSyncDisposal,
} from "@lando/sdk/schema";
import { runFileSyncAppLifecycleContract } from "@lando/sdk/test";
import { Effect, Exit } from "effect";

import { makeFileSyncEngine } from "../src/index.ts";
import type { MutagenProcessClient } from "../src/mutagen-process-client.ts";
import {
  type SessionLedger,
  drainTransitions,
  openLedger,
  projectDisposalPhase,
} from "../src/session-ledger.ts";
import { fake, id, name, runDisposalPlan, spec } from "./support/mutagen-process.ts";

type DrainPhase = NonNullable<SessionLedger["appDrains"]>[number]["phase"];
const DRAIN_PHASES: ReadonlyArray<DrainPhase> = [
  "invalidated",
  "preparing",
  "drained",
  "disposing",
  "completed",
];
/** Ledger phase (or the ledger's "absent") to contract phase. */
const project = (phase: DrainPhase | "absent", ownsSessions: boolean) =>
  projectDisposalPhase(phase === "absent" ? undefined : phase, ownsSessions);
const LIFECYCLE_OPERATIONS = ["invalidateDrain", "drain", "dispose", "completeDisposal"] as const;
const CONTRACT_DRAIN_OPERATIONS = {
  createSession: ["clear-completion"],
  invalidateDrain: ["invalidate-drain"],
  drain: ["begin-drain", "finish-drain"],
  dispose: ["begin-disposal"],
  completeDisposal: ["complete-disposal"],
} as const;

describe("Mutagen disposal lifecycle against the SDK contract table", () => {
  test("the process-client engine satisfies the shared app lifecycle contract", async () => {
    const engine = makeFileSyncEngine({ client: fake().client });
    expect(engine.appLifecycle).toBeDefined();
    const exit = await Effect.runPromiseExit(runFileSyncAppLifecycleContract(engine, spec));
    if (Exit.isFailure(exit)) throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
  });

  test("every ledger drain phase projects onto a contract phase, and both ownership-free phases are reachable", () => {
    const projected = new Set<FileSyncDisposalPhase>([
      ...DRAIN_PHASES.map((phase) => projectDisposalPhase(phase, true)),
      projectDisposalPhase(undefined, true),
      projectDisposalPhase(undefined, false),
    ]);
    expect([...projected].sort()).toEqual(["absent", "active", "completed", "disposing", "drained"]);
    expect(projectDisposalPhase("invalidated", true)).toBe("active");
    expect(projectDisposalPhase("preparing", true)).toBe("active");
  });

  test.each(LIFECYCLE_OPERATIONS)("%s writes only ledger edges the contract table allows", (operation) => {
    const edge = fileSyncDisposalTransitions.edges[operation];
    const writes = CONTRACT_DRAIN_OPERATIONS[operation];
    const first = drainTransitions.edges[writes[0]];
    const last = drainTransitions.edges[writes[writes.length - 1] ?? writes[0]];
    const contractAccepts = new Set<FileSyncDisposalPhase>([...edge.from, ...(edge.settledIn ?? [])]);

    // The ledger only starts the operation from phases the contract accepts.
    const ledgerStarts = [...first.from, ...(first.settledIn ?? [])].map((phase) => project(phase, true));
    for (const phase of ledgerStarts) expect(contractAccepts.has(phase)).toBe(true);
    // Every phase the contract lets the operation leave is one the ledger starts from.
    for (const phase of edge.from) expect(ledgerStarts).toContain(phase);
    // The operation ends where the contract says it does.
    expect(project(last.to ?? "absent", true)).toBe(edge.to ?? "absent");
  });

  test("createSession clears only a completed receipt, which the contract revives as active", () => {
    const [clear] = CONTRACT_DRAIN_OPERATIONS.createSession;
    const edge = fileSyncDisposalTransitions.edges.createSession;
    expect(drainTransitions.edges[clear].from.map((phase) => project(phase, false))).toEqual(["completed"]);
    expect(edge.from).toContain("completed");
    expect(edge.to).toBe("active");
  });

  test("a completed receipt alongside live session receipts is a disagreement, not an active app", async () => {
    const harness = fake();
    await Effect.runPromise(harness.client.create({ name, spec }));
    const bucket = await Effect.runPromise(openLedger(harness.stateStore));
    const current = await Effect.runPromise(bucket.get);
    if (current === null) throw new TypeError("Expected create receipt");
    await Effect.runPromise(
      bucket.set({ ...current, appDrains: [{ app: spec.app, phase: "completed", identifiers: [id] }] }),
    );
    const exit = await Effect.runPromiseExit(harness.reopen().disposalPhase(spec.app));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("receipts disagree");
  });

  test("a drain interrupted mid-flight is still active and the planner finishes the retirement", async () => {
    const harness = fake({ failPauseOnce: true });
    await Effect.runPromise(harness.client.create({ name, spec }));
    expect(Exit.isFailure(await Effect.runPromiseExit(harness.client.drainApp(spec.app)))).toBe(true);

    const resumed = harness.reopen();
    const phase = await Effect.runPromise(resumed.disposalPhase(spec.app));
    expect(phase).toBe("active");
    await Effect.runPromise(runDisposalPlan(resumed, phase));
    expect(await Effect.runPromise(resumed.disposalPhase(spec.app))).toBe("completed");
    expect(harness.current()).toEqual([]);
  });

  test("an interrupted disposal reports disposing and the planner resumes it", async () => {
    const harness = fake({ failTerminateOnce: true });
    await Effect.runPromise(harness.client.create({ name, spec }));
    await Effect.runPromise(harness.client.drainApp(spec.app));
    expect(Exit.isFailure(await Effect.runPromiseExit(harness.client.disposeApp(spec.app)))).toBe(true);

    const resumed = harness.reopen();
    const phase = await Effect.runPromise(resumed.disposalPhase(spec.app));
    expect(phase).toBe("disposing");
    expect(planFileSyncDisposal(phase)).toEqual(["dispose", "completeDisposal"]);
    await Effect.runPromise(runDisposalPlan(resumed, phase));
    expect(await Effect.runPromise(resumed.disposalPhase(spec.app))).toBe("completed");
    expect(harness.current()).toEqual([]);
  });

  test("every lifecycle call rejected by the table leaves the projected phase unchanged", async () => {
    const reachable: ReadonlyArray<{
      readonly phase: FileSyncDisposalPhase;
      readonly arrive: (client: MutagenProcessClient) => Effect.Effect<unknown, unknown>;
    }> = [
      { phase: "active", arrive: (client) => client.create({ name, spec }) },
      {
        phase: "drained",
        arrive: (client) => client.create({ name, spec }).pipe(Effect.andThen(client.drainApp(spec.app))),
      },
      {
        phase: "completed",
        arrive: (client) =>
          client
            .create({ name, spec })
            .pipe(
              Effect.andThen(client.drainApp(spec.app)),
              Effect.andThen(client.disposeApp(spec.app)),
              Effect.andThen(client.completeAppDisposal(spec.app)),
            ),
      },
    ];
    for (const { phase, arrive } of reachable) {
      for (const operation of LIFECYCLE_OPERATIONS) {
        if (fileSyncDisposalTransitions.step(operation, phase)._tag !== "Illegal") continue;
        const harness = fake();
        await Effect.runPromise(arrive(harness.client));
        const client = harness.reopen();
        const calls: Record<
          (typeof LIFECYCLE_OPERATIONS)[number],
          (app: typeof spec.app) => Effect.Effect<void, unknown>
        > = {
          invalidateDrain: client.invalidateAppDrain,
          drain: client.drainApp,
          dispose: client.disposeApp,
          completeDisposal: client.completeAppDisposal,
        };
        const call = calls[operation];
        expect(
          Exit.isFailure(await Effect.runPromiseExit(call(spec.app))),
          `${operation} from ${phase}`,
        ).toBe(true);
        expect(await Effect.runPromise(client.disposalPhase(spec.app))).toBe(phase);
      }
    }
  });
});
