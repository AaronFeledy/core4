/**
 * Uninstall's view of the host changes setup recorded. Each plugin's host maintainer receives the
 * receipts its plugin recorded and plans the undo it can prove, declaring the exact commands as a
 * `HostChange`; the engine gates that change's consent, runs only its declared steps through the
 * uninstall's one session, and moves the receipt through `begin-undo`, `forget`, or
 * `undo-failed`. A `standard` undo runs with `--purge`; a `separate` one (lingering, subordinate
 * ID ranges, the cgroups drop-in, CA trust) runs only when `--undo <id>` (or `--undo all`) names
 * it, because another Lando install or the user's own tools may rely on that host setting now.
 * `--undo` needs `--purge`: `--keep-data` leaves every recorded change in place. Every recorded
 * change is listed under the id `--undo` takes; one no maintainer plans (its owner has none, or
 * the change is a shared package Lando never removes) is a manual step with what the receipt says.
 * Receipts that cannot be read (a corrupt file, a newer format, no permission) never stop an
 * uninstall: it runs without any recorded undo, says so in a manual step naming the file and the
 * error, refuses `--undo` with that reason, and `--purge` still removes the file with the data root.
 */
import type { HostChangeReceipt, HostChangeStep, HostUninstallStep } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import type { UninstallMode, UninstallPlanStep } from "./uninstall.ts";

/** `--undo all` selects every recorded change that has undo steps. */
const UNDO_ALL = "all";

export class UninstallUndoUnavailableError extends Schema.TaggedError<UninstallUndoUnavailableError>()(
  "UninstallUndoUnavailableError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    file: Schema.String,
  },
) {}

/** The receipts file and why it could not be read, already redacted. */
export interface UnreadableReceipts {
  readonly file: string;
  readonly reason: string;
}

export const RECEIPTS_STEP_ID = "host-change-receipts";

/** The plan's step for receipts it could not read: nothing recorded is listed or undone. */
export const unreadableReceiptsStep = ({ file, reason }: UnreadableReceipts): UninstallPlanStep => ({
  id: RECEIPTS_STEP_ID,
  label: "recorded host changes",
  target: file,
  destructive: false,
  status: "manual",
  detail: `Lando could not read ${file}, its record of the host changes setup made (${reason}), so this uninstall lists and undoes none of them. Undo any you no longer want with your system's own tools; \`--purge\` still removes the file with the data root.`,
});

export class UninstallUndoNeedsPurgeError extends Schema.TaggedError<UninstallUndoNeedsPurgeError>()(
  "UninstallUndoNeedsPurgeError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    undo: Schema.Array(Schema.String),
  },
) {}

export class UninstallUndoUnknownError extends Schema.TaggedError<UninstallUndoUnknownError>()(
  "UninstallUndoUnknownError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    unknown: Schema.Array(Schema.String),
    known: Schema.Array(Schema.String),
  },
) {}

const undoable = (receipt: HostChangeReceipt) => receipt.undo._tag === "steps";

/**
 * Fail before any work when `--undo` comes without `--purge`, or names a change Lando has no undo
 * steps for.
 */
export const validateUndoSelection = (
  receipts: ReadonlyArray<HostChangeReceipt>,
  undo: ReadonlyArray<string>,
  mode: UninstallMode,
  unreadable?: UnreadableReceipts,
): Effect.Effect<
  void,
  UninstallUndoNeedsPurgeError | UninstallUndoUnavailableError | UninstallUndoUnknownError
> => {
  if (undo.length > 0 && mode !== "purge") {
    return Effect.fail(
      new UninstallUndoNeedsPurgeError({
        message:
          "`--undo` undoes recorded host changes only together with `--purge`; `--keep-data` leaves every one in place.",
        remediation: `Rerun with \`--purge ${undo.map((id) => `--undo ${id}`).join(" ")}\` to undo them, or without \`--undo\` to keep them.`,
        undo,
      }),
    );
  }
  if (undo.length > 0 && unreadable !== undefined) {
    return Effect.fail(
      new UninstallUndoUnavailableError({
        message: `Lando could not read ${unreadable.file}, its record of the host changes setup made (${unreadable.reason}), so it can undo none of them.`,
        remediation:
          "Rerun without `--undo`; the plan still runs, and `--purge` removes the unreadable record with the data root. Undo the host changes you no longer want with your system's own tools.",
        file: unreadable.file,
      }),
    );
  }
  const known = receipts.filter(undoable).map(({ id }) => String(id));
  const unknown = undo.filter((id) => id !== UNDO_ALL && !known.includes(id));
  if (unknown.length === 0) return Effect.void;
  return Effect.fail(
    new UninstallUndoUnknownError({
      message: `Lando has no recorded host change it can undo named ${unknown.map((id) => `\`${id}\``).join(", ")}.`,
      remediation:
        known.length === 0
          ? "Run `lando uninstall` without `--undo`; Lando recorded no host change it can undo."
          : `Name one of ${known.map((id) => `\`${id}\``).join(", ")}, or \`--undo all\`.`,
      unknown,
      known,
    }),
  );
};

const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

const commandText = (step: HostChangeStep): string =>
  `${step.privileged ? "sudo " : ""}${step.argv.map(shellQuote).join(" ")}`;

const commandsText = (steps: ReadonlyArray<HostChangeStep>): string =>
  steps.map((step) => `\`${commandText(step)}\``).join(", then ");

/**
 * A maintainer's owned step that declares a change runs under `--purge` only when its consent
 * allows; a `separate` undo `--undo` did not name becomes manual and prints its commands.
 */
export const gateContributedUndo = (
  step: HostUninstallStep,
  undo: ReadonlyArray<string>,
): HostUninstallStep => {
  const { change } = step;
  if (change === undefined || step.status !== "owned" || change.consent === "standard") return step;
  const id = String(step.receiptId ?? change.id);
  if (change.consent === "separate" && (undo.includes(UNDO_ALL) || undo.includes(id))) {
    return { ...step, detail: `${step.detail} \`--undo\` named \`${id}\`.` };
  }
  return {
    ...step,
    status: "manual",
    detail: `${step.detail} Rerun with \`--purge --undo ${id}\` to let Lando undo it, or run ${commandsText(change.steps)}. Another Lando install or your own tools may still rely on it.`,
  };
};

/** What `--keep-data` says about a step it leaves in place. */
export const keepDataDetail = (step: Pick<HostUninstallStep, "receiptId">): string =>
  step.receiptId === undefined
    ? "Preserved by --keep-data; rerun with --purge to remove this host-maintained resource."
    : `Preserved by --keep-data; rerun with \`--purge --undo ${step.receiptId}\` to undo it.`;

/** Whether running `step` needs the uninstall's administrator session. */
export const stepNeedsPrivilege = (step: Pick<HostUninstallStep, "change">): boolean =>
  step.change?.steps.some(({ privileged }) => privileged) === true;

/**
 * Manual steps, under the receipt's own id, for recorded changes no maintainer listed: the owner
 * has no maintainer, or the change is one Lando never undoes (a shared package).
 */
export const planUnlistedReceiptSteps = (
  receipts: ReadonlyArray<HostChangeReceipt>,
  input: { readonly mode: UninstallMode | undefined; readonly listed: ReadonlySet<string> },
): ReadonlyArray<UninstallPlanStep> =>
  receipts
    .filter(({ id, undo }) => !input.listed.has(String(id)) && undo._tag !== "none")
    .map((receipt): UninstallPlanStep => {
      const id = String(receipt.id);
      const base = { id, label: receipt.summary, target: id, destructive: false };
      const { undo } = receipt;
      if (input.mode !== "purge") {
        return {
          ...base,
          status: "skipped",
          detail: `Preserved by --keep-data; rerun with --purge to review undoing \`${id}\`.`,
        };
      }
      return {
        ...base,
        status: "manual",
        detail:
          undo._tag === "steps"
            ? `Setup recorded \`${id}\`, which no installed plugin can check, so undo it yourself if nothing needs it: run ${commandsText(undo.steps)}.`
            : `Setup recorded \`${id}\`; Lando does not undo it. ${undo.detail}`,
      };
    });
