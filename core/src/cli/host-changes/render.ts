/**
 * Plain text for a host-change plan: what `lando setup --dry-run` prints and the commands that
 * consent and failure messages quote. Machine output carries the full argv instead.
 */
import { createHash } from "node:crypto";

import type {
  HostChange,
  HostChangePlanEntry,
  HostChangeStep,
  PrivilegeCredentialStatus,
} from "@lando/sdk/schema";

const LONG_ARGUMENT = 200;

const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** One step's argv as a command line, without its input. */
export const hostChangeManualLine = (step: HostChangeStep): string =>
  `${step.privileged ? "sudo " : ""}${step.argv.map(shellWord).join(" ")}`;

/**
 * One step as the plan shows it: a long inline script summarized by its size and digest, and the
 * input it reads described. This describes what Lando runs; it is not a command to copy.
 */
export const hostChangeCommandLine = (step: HostChangeStep): string => {
  const words = step.argv.map((word) =>
    word.length > LONG_ARGUMENT
      ? `<script, ${word.length} bytes, sha256 ${createHash("sha256").update(word).digest("hex").slice(0, 12)}…>`
      : shellWord(word),
  );
  const line = `${step.privileged ? "sudo " : ""}${words.join(" ")}`;
  if (step.stdin === undefined) return line;
  const { summary, sha256, verifiedBy } = step.stdin;
  const binding =
    sha256 !== undefined
      ? `, sha256 ${sha256.slice(0, 12)}…`
      : verifiedBy === undefined
        ? ""
        : `; checked when applied: ${verifiedBy}`;
  return `${line}  (input: ${summary}${binding})`;
};

const credentialLine = (credentials: PrivilegeCredentialStatus): string => {
  switch (credentials.state) {
    case "not-needed":
      return "Administrator access: not needed.";
    case "root":
      return "Administrator access: running as root.";
    case "cached":
      return "Administrator access: sudo already has your credentials.";
    case "askpass":
      return "Administrator access: SUDO_ASKPASS supplies the password.";
    case "will-prompt":
      return "Administrator access: sudo asks for your password once.";
    case "required":
    case "unavailable":
      return `Administrator access: not available to this run.${credentials.detail === undefined ? "" : ` ${credentials.detail}`}`;
    default: {
      const exhaustive: never = credentials.state;
      return exhaustive;
    }
  }
};

const flagsNote = (entry: HostChangePlanEntry): string =>
  entry.approvedBy.length === 0
    ? "only a terminal run can approve it"
    : `${entry.approvedBy.join(" ")} approves it`;

/** What this run would do with the change, and what would approve it otherwise. */
const approvalNote = (entry: HostChangePlanEntry): string => {
  switch (entry.approval) {
    case "approved":
      return "approved";
    case "will-ask":
      return "this run asks";
    case "will-skip":
      return `this run skips it; ${flagsNote(entry)}`;
    case "blocked":
      return `this run stops before changing anything; ${flagsNote(entry)}`;
    case "not-offered":
      return `not offered in this run; ${flagsNote(entry)}`;
    default: {
      const exhaustive: never = entry.approval;
      return exhaustive;
    }
  }
};

const changeLines = (entry: HostChangePlanEntry): ReadonlyArray<string> => {
  const { change } = entry;
  const undo = (undoOf: HostChange["undo"]): string => {
    switch (undoOf._tag) {
      case "steps":
        return `undo: ${undoOf.steps.map(hostChangeCommandLine).join("; ")}`;
      case "manual":
      case "none":
        return `undo: ${undoOf.detail}`;
      default: {
        const exhaustive: never = undoOf;
        return exhaustive;
      }
    }
  };
  return [
    `- ${change.summary} (${change.requirement}, ${approvalNote(entry)})`,
    `  ${change.reason}`,
    ...change.steps.map(
      (step) => `  $ ${hostChangeCommandLine(step)}${step.when === "if-needed" ? "   # only if needed" : ""}`,
    ),
    `  ${undo(change.undo)}`,
  ];
};

export const renderHostChangePlan = (
  entries: ReadonlyArray<HostChangePlanEntry>,
  credentials: PrivilegeCredentialStatus,
): ReadonlyArray<string> => {
  if (entries.length === 0) return ["No host changes planned."];
  const together = entries.filter(({ change }) => change.consent === "standard");
  const apart = entries.filter(({ change }) => change.consent !== "standard");
  const ordered = [
    ...together.filter(({ change }) => change.requirement === "required"),
    ...together.filter(({ change }) => change.requirement === "recommended"),
  ];
  return [
    "Host changes setup would make:",
    ...ordered.flatMap(changeLines),
    ...(apart.length === 0 ? [] : ["Approved separately:", ...apart.flatMap(changeLines)]),
    credentialLine(credentials),
  ];
};
