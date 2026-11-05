import { isDeepStrictEqual } from "node:util";
import { sameRealpath } from "@lando/paths";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { FileSyncSessionSpec } from "@lando/sdk/schema";
import { type Transitions, defineTransitions, illegalTransitionMessage } from "@lando/sdk/transitions";
import { Schema } from "effect";

export const SessionReceipt = Schema.Struct({
  phase: Schema.Literals(["preparing", "committed", "disposing", "disposed"]),
  identifier: Schema.optionalKey(Schema.String),
  name: Schema.String,
  spec: FileSyncSessionSpec,
  target: Schema.Struct({
    containerId: Schema.String,
    path: Schema.String,
    permissions: Schema.optionalKey(
      Schema.Struct({
        owner: Schema.String,
        group: Schema.String,
        defaultFileMode: Schema.String,
        defaultDirectoryMode: Schema.String,
      }),
    ),
  }),
  dataDir: Schema.String,
  dockerHost: Schema.String,
});
export type SessionReceipt = Schema.Schema.Type<typeof SessionReceipt>;
export const AppDrain = Schema.Struct({
  app: FileSyncSessionSpec.fields.app,
  phase: Schema.Literals(["invalidated", "preparing", "drained", "disposing", "completed"]),
  identifiers: Schema.Array(Schema.String),
});
export type AppDrain = Schema.Schema.Type<typeof AppDrain>;
export const SessionLedger = Schema.Struct({
  sessions: Schema.Array(SessionReceipt),
  appDrains: Schema.optionalKey(Schema.Array(AppDrain)),
});
export type SessionLedger = Schema.Schema.Type<typeof SessionLedger>;
export const SESSION_LEDGER_VERSION = 1;
export const EMPTY_LEDGER: SessionLedger = { sessions: [] };
export const openLedger = (stateStore: PluginStateStore) =>
  stateStore.open({
    namespace: "sessions",
    key: "mutagen.json",
    schema: SessionLedger,
    version: SESSION_LEDGER_VERSION,
    codec: "json",
    mode: 0o600,
    lock: "advisory",
    onCorrupt: "fail",
  });

type ReceiptPhase = SessionReceipt["phase"] | "absent";
type DrainPhase = AppDrain["phase"] | "absent";

const receiptTransitions = defineTransitions<ReceiptPhase>()({
  "prepare-create": { from: ["absent"], to: "preparing" },
  "commit-create": { from: ["preparing"], to: "committed" },
  "forget-uncreated": { from: ["preparing"], to: "absent" },
  "begin-disposal": { from: ["committed"], to: "disposing", settledIn: ["disposing"] },
  "record-disposed": { from: ["disposing"], to: "disposed" },
  "complete-disposal": { from: ["disposed"], to: "absent" },
  "begin-terminate": { from: ["committed"], to: "disposing", settledIn: ["disposing"] },
  "finish-terminate": { from: ["disposing"], to: "absent" },
});

const drainTransitions = defineTransitions<DrainPhase>()({
  "invalidate-drain": { from: ["absent", "invalidated", "preparing", "drained"], to: "invalidated" },
  "begin-drain": { from: ["absent", "invalidated", "preparing", "drained"], to: "preparing" },
  "finish-drain": { from: ["preparing"], to: "drained" },
  "begin-disposal": { from: ["drained"], to: "disposing", settledIn: ["disposing"] },
  "complete-disposal": { from: ["disposing"], to: "completed" },
  "clear-completion": { from: ["completed"], to: "absent" },
});

export type ReceiptOperation = keyof typeof receiptTransitions.edges;
export type DrainOperation = keyof typeof drainTransitions.edges;
export interface LedgerWrite {
  readonly next: SessionLedger;
  readonly receipts?: readonly ReceiptOperation[];
  readonly drains?: readonly DrainOperation[];
}

export const sameAppRef = (left: FileSyncSessionSpec["app"], right: FileSyncSessionSpec["app"]): boolean =>
  left.kind === right.kind && left.id === right.id && sameRealpath(left.root, right.root);

const changedEntryIssue = <State extends string, Operation extends string>(
  table: Transitions<State, Operation>,
  operations: readonly Operation[],
  change: { readonly subject: string; readonly from: State; readonly to: State },
): string | undefined => {
  const messages: string[] = [];
  for (const operation of operations) {
    const verdict = table.step(operation, change.from);
    switch (verdict._tag) {
      case "Advance":
        if (verdict.to === change.to) return undefined;
        break;
      case "Settled":
        // Only byte-equivalent entries may settle; callers skip those before checking changes.
        break;
      case "Illegal":
        messages.push(illegalTransitionMessage(change.subject, operation, verdict));
        continue;
      default: {
        const exhaustive: never = verdict;
        return exhaustive;
      }
    }
    messages.push(
      illegalTransitionMessage(change.subject, operation, {
        _tag: "Illegal",
        from: change.from,
        to: table.edges[operation].to,
        accepts: table.edges[operation].from,
      }),
    );
  }
  if (messages.length === 0) {
    messages.push(
      illegalTransitionMessage(change.subject, "write-ledger", {
        _tag: "Illegal",
        from: change.from,
        to: change.to,
        accepts: [],
      }),
    );
  }
  return `${messages.join(" ")} Requested state: ${change.to}. Run lando destroy to finish interrupted disposal, then lando start to recreate the sessions.`;
};

/** Check only changed identities, using the ledger already read under the caller's lock. */
export const ledgerTransitionIssue = (current: SessionLedger, write: LedgerWrite): string | undefined => {
  const next = write.next;
  const names = new Set([...current.sessions, ...next.sessions].map((entry) => entry.name));
  for (const name of names) {
    const previous = current.sessions.find((entry) => entry.name === name);
    const following = next.sessions.find((entry) => entry.name === name);
    if (isDeepStrictEqual(previous, following)) continue;
    const issue = changedEntryIssue(receiptTransitions, write.receipts ?? [], {
      subject: `Mutagen session "${name}"`,
      from: previous?.phase ?? "absent",
      to: following?.phase ?? "absent",
    });
    if (issue !== undefined) return issue;
  }
  const currentDrains = current.appDrains ?? [];
  const nextDrains = next.appDrains ?? [];
  const apps = [
    ...currentDrains,
    ...nextDrains.filter((entry) => !currentDrains.some((prior) => sameAppRef(prior.app, entry.app))),
  ].map((entry) => entry.app);
  for (const app of apps) {
    const previous = currentDrains.find((entry) => sameAppRef(entry.app, app));
    const following = nextDrains.find((entry) => sameAppRef(entry.app, app));
    if (isDeepStrictEqual(previous, following)) continue;
    const issue = changedEntryIssue(drainTransitions, write.drains ?? [], {
      subject: `Mutagen app "${app.id}"`,
      from: previous?.phase ?? "absent",
      to: following?.phase ?? "absent",
    });
    if (issue !== undefined) return issue;
  }
  return undefined;
};
