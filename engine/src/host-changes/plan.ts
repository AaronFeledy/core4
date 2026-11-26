/**
 * Validation and approval preview for one run's host-change plan. Pure: it reads only the
 * proposals services returned and the flags the run was given.
 *
 * A plan is valid when every change id is unique and starts with its owner's package name
 * (`@lando/provider-lando` owns `provider-lando:*`), step ids are unique within a change and
 * within its undo, every privileged step names an absolute program and carries no environment,
 * an opt-in flag belongs only to a `separate` change and is a setup flag the run declares, and
 * no change that only a terminal can approve is required. A step that reads input reads it from
 * its own descriptor 0: Bun hands a child a socket there, and opening `/dev/stdin` (a path to that
 * descriptor) on a socket fails with ENXIO, so no step may name such a path. A change with such a
 * step also says how a person makes it by hand, since its input cannot be typed after a command.
 */
import { HostChangeContractError } from "@lando/sdk/errors";
import type { HostChange, HostChangeApproval, HostChangePlanEntry, HostChangeStep } from "@lando/sdk/schema";
import type { HostChangeProposal } from "@lando/sdk/services";
import { Effect } from "effect";

export interface HostChangePlanContext {
  /** Setup flags the selected provider and plugins declare. */
  readonly setupFlags: ReadonlySet<string>;
}

export interface HostChangeApprovalInputs {
  readonly yes: boolean;
  /** Opt-in flags the run was given. */
  readonly optInFlags: ReadonlySet<string>;
  /** Whether the run can ask in a terminal: interactive, and not `--no-interactive`. */
  readonly canAsk: boolean;
}

/** What a run does about one change before anything changes. */
export type HostChangeDecision = "approved" | "ask" | "missing" | "skipped" | "not-offered";

/**
 * The one consent decision. Setup's real run (which then asks, or fails on `missing`) and its dry
 * run both take it from here, so the preview never promises what the run would not do.
 *
 * | consent          | `--yes`                    | terminal run, no `--yes`          | cannot ask, no `--yes`                          |
 * | ---------------- | -------------------------- | --------------------------------- | ----------------------------------------------- |
 * | standard         | approves                   | one question for all of them       | required fails naming `--yes`; else skipped     |
 * | separate         | its opt-in flag approves   | its own question, unless flagged   | required fails naming its flag; else skipped    |
 * | interactive-only | not offered                | its own question                   | not offered                                     |
 */
export const decideHostChange = (
  change: HostChange,
  inputs: HostChangeApprovalInputs,
): HostChangeDecision => {
  const unapproved: HostChangeDecision = change.requirement === "required" ? "missing" : "skipped";
  switch (change.consent) {
    case "standard":
      if (inputs.yes) return "approved";
      return inputs.canAsk ? "ask" : unapproved;
    case "separate":
      if (change.optInFlag !== undefined && inputs.optInFlags.has(change.optInFlag)) return "approved";
      // `--yes` asks for no prompts, and it does not approve this change either.
      return inputs.canAsk && !inputs.yes ? "ask" : unapproved;
    case "interactive-only":
      return inputs.canAsk && !inputs.yes ? "ask" : "not-offered";
    default: {
      const exhaustive: never = change.consent;
      return exhaustive;
    }
  }
};

/** `@lando/provider-lando` -> `provider-lando`; `@lando/core` -> `core`. */
const hostChangeOwnerName = (owner: string): string => owner.slice(owner.lastIndexOf("/") + 1);

export const hostChangeContractError = (change: Pick<HostChange, "id" | "owner">, detail: string) =>
  new HostChangeContractError({
    owner: change.owner,
    changeId: change.id,
    detail,
    message: `${change.owner} planned an invalid host change ${change.id}: ${detail}.`,
    remediation: `Report this to the maintainers of ${change.owner}; Lando changed nothing.`,
  });

const STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);

/**
 * Bytes piped to root are bound to what was approved: by the digest the plan declared, or, for
 * input that does not exist yet, by an apply-time check the plan describes.
 */
const stdinViolation = (step: HostChangeStep): string | undefined => {
  const { stdin } = step;
  if (stdin === undefined || !step.privileged) return undefined;
  const bound = stdin.sha256 !== undefined;
  const deferred = stdin.boundAt === "apply";
  if (bound && deferred) return `privileged step ${step.id} binds its input both at plan time and at apply`;
  if (deferred && (stdin.verifiedBy === undefined || stdin.verifiedBy.trim().length === 0))
    return `privileged step ${step.id} binds its input at apply without saying how it is checked`;
  if (!bound && !deferred)
    return `privileged step ${step.id} reads input that neither a planned digest nor an apply-time check binds`;
  return undefined;
};

const stepViolation = (steps: ReadonlyArray<HostChangeStep>): string | undefined => {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.argv.some((word) => STDIN_PATHS.has(word)))
      return `step ${step.id} opens its input by path; read descriptor 0 instead, as \`tee <file>\` does`;
    const stdin = stdinViolation(step);
    if (stdin !== undefined) return stdin;
    if (seen.has(step.id)) return `step ${step.id} is declared twice`;
    seen.add(step.id);
    if (step.privileged && !step.argv[0].startsWith("/"))
      return `privileged step ${step.id} must name an absolute program`;
    if (step.privileged && step.env !== undefined)
      return `privileged step ${step.id} cannot set an environment`;
  }
  return undefined;
};

const changeViolation = (change: HostChange, context: HostChangePlanContext): string | undefined => {
  const owner = hostChangeOwnerName(change.owner);
  if (!change.id.startsWith(`${owner}:`)) return `its id must start with "${owner}:"`;
  const steps = stepViolation(change.steps);
  if (steps !== undefined) return steps;
  if (change.manual === undefined && change.steps.some((step) => step.stdin !== undefined))
    return "a change whose step reads input must say how to make it by hand";
  if (change.undo._tag === "steps") {
    const undo = stepViolation(change.undo.steps);
    if (undo !== undefined) return `undo ${undo}`;
  }
  // A run that cannot ask must always have a flag that approves a separate change.
  if (change.consent === "separate" && change.optInFlag === undefined)
    return "a separately approved change must name the opt-in flag that approves it";
  if (change.optInFlag !== undefined) {
    if (change.consent !== "separate") return "only a separately approved change may name an opt-in flag";
    if (!context.setupFlags.has(change.optInFlag))
      return `--${change.optInFlag} is not a setup flag of this run`;
  }
  if (change.consent === "interactive-only" && change.requirement === "required") {
    return "a change only a terminal can approve cannot be required";
  }
  return undefined;
};

export const validateHostChangePlan = Effect.fnUntraced(function* (
  proposals: ReadonlyArray<HostChangeProposal>,
  context: HostChangePlanContext,
): Effect.fn.Return<ReadonlyArray<HostChangeProposal>, HostChangeContractError> {
  const ids = new Set<string>();
  for (const { change } of proposals) {
    if (ids.has(change.id))
      return yield* Effect.fail(hostChangeContractError(change, "its id is planned twice"));
    ids.add(change.id);
    const violation = changeViolation(change, context);
    if (violation !== undefined) return yield* Effect.fail(hostChangeContractError(change, violation));
  }
  return proposals;
});

/**
 * The flags that approve `change` in a run that does not ask, read off the same decision: `--yes`
 * when it approves, otherwise the change's own opt-in flag when that does, otherwise none.
 */
export const hostChangeApprovedBy = (change: HostChange): ReadonlyArray<string> => {
  const approvesUnattended = (yes: boolean, optInFlags: ReadonlySet<string>) =>
    decideHostChange(change, { yes, optInFlags, canAsk: false }) === "approved";
  if (approvesUnattended(true, new Set())) return ["--yes"];
  const flag = change.optInFlag;
  if (flag !== undefined && approvesUnattended(false, new Set([flag]))) return [`--${flag}`];
  return [];
};

const APPROVAL: Record<HostChangeDecision, HostChangeApproval> = {
  approved: "approved",
  ask: "will-ask",
  skipped: "will-skip",
  missing: "blocked",
  "not-offered": "not-offered",
};

/** What this run would do with each change, from the same decision consent makes. */
export const previewApprovals = (
  changes: ReadonlyArray<HostChange>,
  inputs: HostChangeApprovalInputs,
): ReadonlyArray<HostChangePlanEntry> =>
  changes.map((change) => ({
    change,
    approval: APPROVAL[decideHostChange(change, inputs)],
    approvedBy: [...hostChangeApprovedBy(change)],
  }));

/** Whether any change in the plan runs a step as root, so the run needs credentials. */
export const planNeedsPrivilege = (changes: ReadonlyArray<HostChange>): boolean =>
  changes.some((change) => change.steps.some((step) => step.privileged));
