/**
 * Consent for one run's host changes, decided before anything changes. The decision itself is the
 * engine's `decideHostChange`, which the dry-run preview shares; this module asks the questions
 * it calls for and words the failures and warnings.
 *
 * A run that cannot get a required approval fails before it asks anything. Answering no to a
 * required change fails at once; declining a recommended one skips it with a warning.
 */
import { decideHostChange, hostChangeApprovedBy } from "@lando/engine/host-changes/plan";
import { HostChangeConsentRequiredError, HostChangeDeclinedError } from "@lando/sdk/errors";
import type { HostChange, HostChangeId } from "@lando/sdk/schema";
import type { InteractionError, InteractionServiceShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { hostChangeManualLine } from "./render.ts";

export interface HostChangeConsentOptions {
  readonly yes: boolean;
  /** Opt-in flags the run was given. */
  readonly optInFlags: ReadonlySet<string>;
  /** Present only when this run may ask questions in a terminal. */
  readonly interaction: InteractionServiceShape | undefined;
}

export interface HostChangeConsent {
  readonly approved: ReadonlySet<HostChangeId>;
  /** One line per recommended change this run skips, saying how to apply it later. */
  readonly warnings: ReadonlyArray<string>;
}

const decide = (change: HostChange, options: HostChangeConsentOptions) =>
  decideHostChange(change, {
    yes: options.yes,
    optInFlags: options.optInFlags,
    canAsk: options.interaction !== undefined,
  });

/** The flags that approve every change a run cannot otherwise get, as one command-line fragment. */
const approvingFlags = (changes: ReadonlyArray<HostChange>): ReadonlyArray<string> => [
  ...new Set(changes.flatMap(hostChangeApprovedBy)),
];

const consentRequired = (changes: ReadonlyArray<HostChange>) => {
  const flags = approvingFlags(changes);
  return new HostChangeConsentRequiredError({
    changeIds: changes.map((change) => change.id),
    flags: [...flags],
    message: `Setup needs your approval for these changes, and this run cannot ask: ${changes.map((change) => change.summary).join("; ")}.`,
    remediation: `Review \`lando setup --dry-run\`, then rerun with \`${flags.join(" ")}\`, or run \`lando setup\` in a terminal.`,
  });
};

/** What a person can run to make the change by hand; a step reading input never renders its input. */
const manualCommands = (change: HostChange): string =>
  change.manual === undefined
    ? change.steps.map((step) => `\`${hostChangeManualLine(step)}\``).join(", then ")
    : `\`${change.manual}\``;

const declined = (change: HostChange) =>
  new HostChangeDeclinedError({
    changeIds: [change.id],
    message: `Setup cannot finish without this change: ${change.summary}. ${change.reason}`,
    remediation: `Rerun \`lando setup\` and approve it, or make the change yourself (${manualCommands(change)}) and rerun \`lando setup\`.`,
  });

const skippedWarning = (change: HostChange): string => {
  const flag = change.optInFlag === undefined ? "" : `, rerun with \`--${change.optInFlag}\``;
  return `Lando skipped this change: ${change.summary}. ${change.reason} To apply it, rerun \`lando setup\` in a terminal and approve it${flag}, or run ${manualCommands(change)} yourself.`;
};

const listChanges = (changes: ReadonlyArray<HostChange>): string =>
  [...changes]
    .sort(
      (left, right) =>
        Number(left.requirement === "recommended") - Number(right.requirement === "recommended"),
    )
    .map((change) => `  - ${change.summary}${change.requirement === "required" ? "" : " (recommended)"}`)
    .join("\n");

export const decideHostChangeConsent = Effect.fnUntraced(function* (
  changes: ReadonlyArray<HostChange>,
  options: HostChangeConsentOptions,
): Effect.fn.Return<
  HostChangeConsent,
  HostChangeConsentRequiredError | HostChangeDeclinedError | InteractionError
> {
  const decisions = changes.map((change) => ({ change, decision: decide(change, options) }));
  const missing = decisions.filter(({ decision }) => decision === "missing").map(({ change }) => change);
  if (missing.length > 0) return yield* Effect.fail(consentRequired(missing));

  const answers = new Map<HostChangeId, boolean>();
  const standard = decisions.filter(
    ({ change, decision }) => decision === "ask" && change.consent === "standard",
  );
  const interaction = options.interaction;
  if (standard.length > 0 && interaction !== undefined) {
    const approved = yield* Effect.scoped(
      interaction.confirm({
        name: "setup-host-changes",
        message: `Setup needs to change your system:\n${listChanges(standard.map(({ change }) => change))}\nRun \`lando setup --dry-run\` to see the exact commands.\nApprove these changes?`,
        default: false,
      }),
    );
    const refused = standard.find(({ change }) => !approved && change.requirement === "required");
    if (refused !== undefined) return yield* Effect.fail(declined(refused.change));
    for (const { change } of standard) answers.set(change.id, approved);
  }
  for (const { change, decision } of decisions) {
    if (decision !== "ask" || change.consent === "standard" || interaction === undefined) continue;
    const persistence = change.persistent
      ? "\nIt stays in effect after setup ends, across logout and reboot."
      : "";
    const approved = yield* Effect.scoped(
      interaction.confirm({
        name: `setup-host-change-${change.id.replace(":", "-")}`,
        message: `${change.reason}${persistence}\n${change.summary}?`,
        default: false,
      }),
    );
    if (!approved && change.requirement === "required") return yield* Effect.fail(declined(change));
    answers.set(change.id, approved);
  }

  const isApproved = ({ change, decision }: (typeof decisions)[number]) =>
    decision === "approved" || answers.get(change.id) === true;
  const warnings = decisions
    .filter(
      (entry) =>
        !isApproved(entry) && entry.decision !== "not-offered" && entry.change.requirement === "recommended",
    )
    .map(({ change }) => skippedWarning(change));
  const approved = new Set(decisions.filter(isApproved).map(({ change }) => change.id));
  return { approved, warnings };
});
