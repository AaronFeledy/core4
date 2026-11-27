import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { HostChangeFailedError } from "@lando/sdk/errors";
import { type HostChange, HostChangeId, type HostChangeUndo } from "@lando/sdk/schema";
import type { HostChangeProposal, PrivilegeSession } from "@lando/sdk/services";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect, Exit } from "effect";
import { makeHostChangeApplier } from "../../src/host-changes/apply";
import {
  type HostChangeReceiptStore,
  hostChangeReceiptTransitions,
  makeHostChangeReceiptStore,
  planHostChangeReceiptWrite,
} from "../../src/host-changes/receipts";
import { proposal } from "./fixtures";

const id = HostChangeId.make("provider-test:enable-thing");

const undo: HostChangeUndo = {
  _tag: "steps",
  consent: "separate",
  summary: "Disable the thing",
  steps: [
    {
      id: "disable",
      summary: "Disable it",
      argv: ["/usr/bin/thing", "disable"],
      privileged: true,
      when: "always",
    },
  ],
};

const twoSteps: Partial<HostChange> = {
  undo,
  details: { user: "dev" },
  steps: [
    {
      id: "enable",
      summary: "Enable it",
      argv: ["/usr/bin/thing", "enable"],
      privileged: true,
      when: "always",
    },
    {
      id: "verify",
      summary: "Verify it",
      argv: ["/usr/bin/thing", "check"],
      privileged: true,
      when: "always",
    },
  ],
};

const session = (exitCodes: ReadonlyArray<number> = []): PrivilegeSession => {
  let call = 0;
  return {
    transport: "cached",
    elevate: () => Effect.sync(() => ({ exitCode: exitCodes[call++] ?? 0, stdout: "", stderr: "" })),
  };
};

const applyWith = (
  receipts: HostChangeReceiptStore,
  planned: HostChangeProposal,
  exitCodes: ReadonlyArray<number> = [],
) =>
  Effect.runPromiseExit(
    makeHostChangeApplier({
      proposals: [planned],
      approved: new Set([planned.change.id]),
      session: session(exitCodes),
      redact: String,
      receipts,
    }).applier.apply(planned.change.id),
  );

const runsBoth: HostChangeProposal["apply"] = (steps) =>
  Effect.gen(function* () {
    for (const step of ["enable", "verify"]) {
      const result = yield* steps.run(step);
      if (result.exitCode !== 0)
        return yield* Effect.fail(
          new HostChangeFailedError({ changeId: id, message: "failed", remediation: "retry" }),
        );
    }
    return { changed: true, facts: { range: "100000-165535" } };
  });

describe("host-change receipts", () => {
  test("record a change that took effect, with planned and learned facts and its undo", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);

    await applyWith(receipts, proposal(twoSteps, runsBoth));

    const [receipt, ...rest] = await Effect.runPromise(receipts.list);
    expect(rest).toEqual([]);
    expect(receipt).toMatchObject({
      id,
      owner: "@lando/provider-test",
      phase: "applied",
      facts: { user: "dev", range: "100000-165535" },
      undo,
    });
    expect(receipt?.appliedAt).toBeString();
  });

  test.each([
    ["the host already had it", proposal({ undo }, () => Effect.succeed({ changed: false })), []],
    ["its first step failed", proposal(twoSteps, runsBoth), [1]],
    ["it has nothing to undo", proposal({}, runsBoth), []],
  ] as const)("keep no receipt when %s", async (_name, planned, exitCodes) => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);

    await applyWith(receipts, planned, exitCodes);

    expect(await Effect.runPromise(receipts.list)).toEqual([]);
  });

  test("keep a half-made change: a later step failed after a privileged one succeeded", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);

    const exit = await applyWith(receipts, proposal(twoSteps, runsBoth), [0, 1]);

    expect(Exit.isFailure(exit)).toBe(true);
    expect((await Effect.runPromise(receipts.list)).map(({ phase }) => phase)).toEqual(["applied"]);
  });

  test("a rerun that finds the change in place keeps the earlier receipt", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    await applyWith(receipts, proposal(twoSteps, runsBoth));

    await applyWith(
      receipts,
      proposal(twoSteps, () => Effect.succeed({ changed: false })),
    );

    expect((await Effect.runPromise(receipts.list)).map(({ phase }) => phase)).toEqual(["applied"]);
  });

  test("an interrupted attempt's applying record survives a rerun that finds nothing to do", async () => {
    // Given a record an earlier attempt left applying: its first step ran, then it was killed.
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    await Effect.runPromise(
      receipts.write({
        operation: "begin-apply",
        receipt: {
          id,
          owner: "@lando/provider-test",
          summary: "Enable the thing",
          attempt: "earlier",
          startedAt: "2026-11-26T00:00:00.000Z",
          undo,
        },
      }),
    );

    // When a rerun finds the change already in place, or fails before any privileged step succeeds.
    await applyWith(
      receipts,
      proposal(twoSteps, () => Effect.succeed({ changed: false })),
    );
    await applyWith(receipts, proposal(twoSteps, runsBoth), [1]);

    // Then the only record of what the earlier attempt may have done is still there.
    expect((await Effect.runPromise(receipts.list)).map(({ phase, attempt }) => [phase, attempt])).toEqual([
      ["applying", "earlier"],
    ]);
  });

  test("a rerun that makes the change records it applied over an interrupted attempt's record", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    await Effect.runPromise(
      receipts.write({
        operation: "begin-apply",
        receipt: {
          id,
          owner: "@lando/provider-test",
          summary: "Enable the thing",
          attempt: "earlier",
          startedAt: "2026-11-26T00:00:00.000Z",
          undo,
        },
      }),
    );

    await applyWith(receipts, proposal(twoSteps, runsBoth));

    const [receipt] = await Effect.runPromise(receipts.list);
    expect(receipt?.phase).toBe("applied");
    expect(receipt?.attempt).toBeUndefined();
  });

  test("only the attempt that began a record may drop it", async () => {
    const begun = {
      id,
      owner: "@lando/provider-test",
      summary: "Enable",
      startedAt: "2026-11-26T00:00:00.000Z",
      undo,
    };
    const mine = { ...begun, phase: "applying" as const, attempt: "mine" };

    const own = await Effect.runPromise(
      planHostChangeReceiptWrite(mine, { operation: "abandon", id, attempt: "mine" }),
    );
    const other = await Effect.runPromise(
      planHostChangeReceiptWrite(mine, { operation: "abandon", id, attempt: "other" }),
    );
    const unmarked = await Effect.runPromise(
      planHostChangeReceiptWrite(
        { ...begun, phase: "applying" },
        { operation: "abandon", id, attempt: "other" },
      ),
    );

    expect([own._tag, other._tag, unmarked._tag]).toEqual(["Remove", "Keep", "Keep"]);
  });

  test("a receipt that cannot be written stops the change before it runs", async () => {
    let ran = false;
    const failing: HostChangeReceiptStore = {
      list: Effect.succeed([]),
      write: () =>
        Effect.fail(
          new HostChangeFailedError({ changeId: id, message: "disk full", remediation: "free space" }),
        ),
    };

    const exit = await applyWith(
      failing,
      proposal({ undo }, () =>
        Effect.sync(() => {
          ran = true;
          return { changed: true };
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(ran).toBe(false);
  });

  test("undo moves a receipt through undoing to gone, and a failed undo restores it", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    await applyWith(receipts, proposal(twoSteps, runsBoth));
    const phases = () => Effect.runPromise(receipts.list).then((list) => list.map(({ phase }) => phase));

    await Effect.runPromise(receipts.write({ operation: "begin-undo", id }));
    expect(await phases()).toEqual(["undoing"]);
    await Effect.runPromise(receipts.write({ operation: "undo-failed", id }));
    expect(await phases()).toEqual(["applied"]);
    await Effect.runPromise(receipts.write({ operation: "begin-undo", id }));
    await Effect.runPromise(receipts.write({ operation: "forget", id }));
    expect(await phases()).toEqual([]);
  });

  test("setup after an interrupted undo keeps the original record, applied with its facts and undo", async () => {
    // Given a change Lando recorded with what it learned, whose undo was interrupted.
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    await applyWith(receipts, proposal(twoSteps, runsBoth));
    await Effect.runPromise(receipts.write({ operation: "begin-undo", id }));
    const [original] = await Effect.runPromise(receipts.list);
    if (original === undefined) throw new Error("expected the recorded change");

    // When setup applies it again and fails before any privileged step succeeds.
    await applyWith(receipts, proposal({ ...twoSteps, details: { user: "other" } }, runsBoth), [1]);

    // Then the record is the original one, applied again, not a new attempt's.
    const [receipt] = await Effect.runPromise(receipts.list);
    expect(receipt).toEqual({ ...original, phase: "applied" });
    expect(receipt?.facts).toEqual({ user: "dev", range: "100000-165535" });
    expect(receipt?.undo).toEqual(undo);
  });

  test("an applied change's receipt records the digest of the input root read", async () => {
    const receipts = makeHostChangeReceiptStore(makeTestStateStore().service);
    const bytes = new TextEncoder().encode("anchor\n");
    const writing = proposal(
      {
        undo,
        manual: "Write it yourself.",
        steps: [
          {
            id: "write",
            summary: "Write it",
            argv: ["/usr/bin/tee", "/etc/x"],
            privileged: true,
            stdin: { summary: "the anchor", boundAt: "apply", verifiedBy: "one PEM certificate" },
            when: "always",
          },
        ],
      },
      (steps) => steps.run("write", { stdin: bytes }).pipe(Effect.as({ changed: true })),
    );

    await applyWith(receipts, writing);

    const [receipt] = await Effect.runPromise(receipts.list);
    expect(receipt?.facts).toEqual({
      "stdin.write.sha256": createHash("sha256").update(bytes).digest("hex"),
    });
  });

  test("an operation the record's phase does not allow fails with remediation and writes nothing", async () => {
    const exit = await Effect.runPromiseExit(
      planHostChangeReceiptWrite(undefined, { operation: "begin-undo", id }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(hostChangeReceiptTransitions.step("forget", "absent")._tag).toBe("Settled");
    expect(hostChangeReceiptTransitions.step("record-applied", "undoing")._tag).toBe("Illegal");
  });
});
