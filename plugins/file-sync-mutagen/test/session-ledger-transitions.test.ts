import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { type SessionLedger, type SessionReceipt, ledgerTransitionIssue } from "../src/session-ledger.ts";
import { helper, id, name, spec } from "./support/mutagen-process.ts";

const receipt: SessionReceipt = {
  phase: "committed",
  identifier: id,
  name,
  spec,
  target: { containerId: helper, path: "/lando-data" },
  dataDir: "C:\\lando\\data\\file-sync\\sessions",
  dockerHost: "npipe:////./pipe/podman-lando",
};

test("recovery checks every changed identity while ignoring reordered unchanged siblings", () => {
  const adopt = { ...receipt, name: "adopt", phase: "preparing" } as const;
  const forget = { ...receipt, name: "forget", phase: "preparing" } as const;
  const siblingDrain = { app: spec.app, phase: "drained", identifiers: [id] } as const;
  const current: SessionLedger = {
    sessions: [receipt, adopt, forget],
    appDrains: [siblingDrain],
  };
  const next: SessionLedger = {
    sessions: [{ ...adopt, phase: "committed" }, { ...receipt }],
    appDrains: [{ ...siblingDrain }],
  };
  expect(
    ledgerTransitionIssue(current, { next, receipts: ["commit-create", "forget-uncreated"] }),
  ).toBeUndefined();
  expect(ledgerTransitionIssue(current, { next, receipts: ["commit-create"] })).toContain('"forget"');
});

test("an operation cannot borrow another operation's edge with the same destination", () => {
  const current: SessionLedger = { sessions: [{ ...receipt, phase: "preparing" }] };
  expect(
    ledgerTransitionIssue(current, { next: { sessions: [] }, receipts: ["finish-terminate"] }),
  ).toContain("finish-terminate while preparing");
});

test("settled disposal retries cannot rewrite receipt identity metadata", () => {
  const disposing = { ...receipt, phase: "disposing" } as const;
  const current: SessionLedger = { sessions: [disposing] };
  expect(
    ledgerTransitionIssue(current, { next: { sessions: [{ ...disposing }] }, receipts: ["begin-disposal"] }),
  ).toBeUndefined();
  expect(
    ledgerTransitionIssue(current, {
      next: { sessions: [{ ...disposing, identifier: "sync_Other" }] },
      receipts: ["begin-disposal"],
    }),
  ).toContain(name);
});

test("both axes require their own permission when disposal removes receipts", () => {
  const current: SessionLedger = {
    sessions: [{ ...receipt, phase: "disposed" }],
    appDrains: [{ app: spec.app, phase: "disposing", identifiers: [id] }],
  };
  const next: SessionLedger = {
    sessions: [],
    appDrains: [{ app: spec.app, phase: "completed", identifiers: [id] }],
  };
  expect(ledgerTransitionIssue(current, { next, receipts: ["complete-disposal"] })).toContain('app "cms"');
  expect(ledgerTransitionIssue(current, { next, drains: ["complete-disposal"] })).toContain(name);
});

test("checks newly inserted entries and refuses an operation's wrong destination", () => {
  expect(
    ledgerTransitionIssue({ sessions: [] }, { next: { sessions: [receipt] }, receipts: ["prepare-create"] }),
  ).toContain("Requested state: committed");
  const otherApp = { ...spec.app, id: AppId.make("other") };
  const current: SessionLedger = {
    sessions: [],
    appDrains: [{ app: spec.app, phase: "completed", identifiers: [id] }],
  };
  expect(
    ledgerTransitionIssue(current, {
      next: {
        ...current,
        appDrains: [...(current.appDrains ?? []), { app: otherApp, phase: "drained", identifiers: [] }],
      },
      drains: ["begin-drain"],
    }),
  ).toContain('app "other"');
});
