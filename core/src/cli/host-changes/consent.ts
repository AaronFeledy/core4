/**
 * Consent for one run's host changes, decided before anything changes. The decision itself is the
 * engine's `decideHostChange`, which the dry-run preview shares; this module asks the questions
 * it calls for and words the failures and warnings.
 *
 * A run that cannot get a required approval fails before it asks anything. Answering no to a
 * required change fails at once; declining a recommended one skips it with a warning. A required
 * `separate` change (lingering when the session has no runtime directory) names its own flag, its
 * reason, and the commands that make it by hand, since `--yes` never approves it. Every sentence
 * names the command that asks (`lando setup` or `lando doctor --fix`) and only the flags and
 * previews that command has.
 */
import { decideHostChange, hostChangeApprovedBy } from "@lando/engine/host-changes/plan";
import { HostChangeConsentRequiredError, HostChangeDeclinedError } from "@lando/sdk/errors";
import type { HostChange, HostChangeId } from "@lando/sdk/schema";
import type { InteractionError, InteractionServiceShape } from "@lando/sdk/services";
import { Effect } from "effect";

import { hostChangeManualLine } from "./render.ts";

/** The command asking for approval. */
export type HostChangeConsentCommand = "setup" | "doctor";

interface ConsentCopy {
  /** Who needs the change, as a sentence subject. */
  readonly subject: string;
  /** The command a person reruns to approve in a terminal. */
  readonly rerun: string;
  /** Where the exact commands are shown before approving, when the command has such a view. */
  readonly preview?: string;
  /** How a run that cannot ask gets approval. */
  readonly withoutTerminal: (flags: ReadonlyArray<string>) => string;
}

/** The flags as one command-line fragment a person can paste. */
const quoted = (flags: ReadonlyArray<string>): string => `\`${flags.join(" ")}\``;

const COPY: Record<HostChangeConsentCommand, ConsentCopy> = {
  setup: {
    subject: "Setup",
    rerun: "`lando setup`",
    preview: "Run `lando setup --dry-run` to see the exact commands.",
    withoutTerminal: (flags) =>
      `Review \`lando setup --dry-run\`, then rerun with ${quoted(flags)}, or run \`lando setup\` in a terminal.`,
  },
  // Doctor has no `--yes` or `--dry-run`: it asks only in a terminal, and setup makes the same changes.
  doctor: {
    subject: "Doctor",
    rerun: "`lando doctor --fix`",
    withoutTerminal: (flags) =>
      `Rerun \`lando doctor --fix\` in a terminal to approve them, or run \`lando setup\` with ${quoted(flags)}, which makes the same changes.`,
  },
};

export interface HostChangeConsentOptions {
  readonly command: HostChangeConsentCommand;
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

/** What a person can run to make the change by hand; a step reading input never renders its input. */
const manualCommands = (change: HostChange): string =>
  change.manual === undefined
    ? change.steps.map((step) => `\`${hostChangeManualLine(step)}\``).join(", then ")
    : `\`${change.manual}\``;

/** A separate change has its own flag and alternatives; the shared `--yes` does not approve it. */
const separateAlternatives = (changes: ReadonlyArray<HostChange>): string =>
  changes
    .filter((change) => change.consent === "separate")
    .map(
      (change) =>
        ` ${change.summary}: ${change.reason} To make this change yourself, run ${manualCommands(change)}.`,
    )
    .join("");

const consentRequired = (copy: ConsentCopy, changes: ReadonlyArray<HostChange>) => {
  const flags = approvingFlags(changes);
  return new HostChangeConsentRequiredError({
    changeIds: changes.map((change) => change.id),
    flags: [...flags],
    message: `${copy.subject} needs your approval for these changes, and this run cannot ask: ${changes.map((change) => change.summary).join("; ")}.`,
    remediation: `${copy.withoutTerminal(flags)}${separateAlternatives(changes)}`,
  });
};

const declined = (copy: ConsentCopy, change: HostChange) =>
  new HostChangeDeclinedError({
    changeIds: [change.id],
    message: `${copy.subject} cannot finish without this change: ${change.summary}. ${change.reason}`,
    remediation: `Rerun ${copy.rerun} and approve it${change.optInFlag === undefined ? "" : ` (or pass \`--${change.optInFlag}\`)`}, or make the change yourself (${manualCommands(change)}) and rerun ${copy.rerun}.`,
  });

const skippedWarning = (copy: ConsentCopy, change: HostChange): string => {
  const flag = change.optInFlag === undefined ? "" : `, rerun with \`--${change.optInFlag}\``;
  return `Lando skipped this change: ${change.summary}. ${change.reason} To apply it, rerun ${copy.rerun} in a terminal and approve it${flag}, or run ${manualCommands(change)} yourself.`;
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
  const copy = COPY[options.command];
  const decisions = changes.map((change) => ({ change, decision: decide(change, options) }));
  const missing = decisions.filter(({ decision }) => decision === "missing").map(({ change }) => change);
  if (missing.length > 0) return yield* Effect.fail(consentRequired(copy, missing));

  const answers = new Map<HostChangeId, boolean>();
  const standard = decisions.filter(
    ({ change, decision }) => decision === "ask" && change.consent === "standard",
  );
  const interaction = options.interaction;
  if (standard.length > 0 && interaction !== undefined) {
    const approved = yield* Effect.scoped(
      interaction.confirm({
        name: `${options.command}-host-changes`,
        message: [
          `${copy.subject} needs to change your system:`,
          listChanges(standard.map(({ change }) => change)),
          ...(copy.preview === undefined ? [] : [copy.preview]),
          "Approve these changes?",
        ].join("\n"),
        default: false,
      }),
    );
    const refused = standard.find(({ change }) => !approved && change.requirement === "required");
    if (refused !== undefined) return yield* Effect.fail(declined(copy, refused.change));
    for (const { change } of standard) answers.set(change.id, approved);
  }
  for (const { change, decision } of decisions) {
    if (decision !== "ask" || change.consent === "standard" || interaction === undefined) continue;
    const persistence = change.persistent
      ? `\nIt stays in effect after ${copy.subject.toLowerCase()} ends, across logout and reboot.`
      : "";
    const necessity = change.requirement === "required" ? `\n${copy.subject} cannot finish without it.` : "";
    const approved = yield* Effect.scoped(
      interaction.confirm({
        name: `${options.command}-host-change-${change.id.replace(":", "-")}`,
        message: `${change.reason}${persistence}${necessity}\n${change.summary}?`,
        default: false,
      }),
    );
    if (!approved && change.requirement === "required") return yield* Effect.fail(declined(copy, change));
    answers.set(change.id, approved);
  }

  const isApproved = ({ change, decision }: (typeof decisions)[number]) =>
    decision === "approved" || answers.get(change.id) === true;
  const warnings = decisions
    .filter(
      (entry) =>
        !isApproved(entry) && entry.decision !== "not-offered" && entry.change.requirement === "recommended",
    )
    .map(({ change }) => skippedWarning(copy, change));
  const approved = new Set(decisions.filter(isApproved).map(({ change }) => change.id));
  return { approved, warnings };
});
