/**
 * Applies one run's approved host changes. A change runs only the steps it declared, a declared
 * input digest is checked before its step runs, privileged steps go through the run's single
 * administrator session, and each change applies at most once per run. Step output reaches the
 * proposal redacted. The applier publishes nothing, so it never opens a task tree of its own.
 *
 * With a receipt store, a change that has something to undo is recorded before it runs and
 * settled afterwards: `applied` once it took effect, or once any privileged step succeeded before
 * a later one failed (a half-made change is still Lando's); otherwise the record this attempt began
 * is dropped. A record an interrupted earlier attempt left `applying` is never dropped, since that
 * attempt may have changed the host. A receipt that cannot be written stops the change before it
 * runs.
 */
import { createHash, randomUUID } from "node:crypto";

import { PrivilegeUnavailableError } from "@lando/sdk/errors";
import type { HostChange, HostChangeId, HostChangeOutcome } from "@lando/sdk/schema";
import type {
  HostChangeApplier,
  HostChangeApplyError,
  HostChangeApplyResult,
  HostChangeProposal,
  HostChangeStepRunner,
  PrivilegeSession,
  ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { type Context, DateTime, Deferred, Effect, Exit } from "effect";

import { hostChangeContractError } from "./plan.ts";
import type { HostChangeReceiptStore } from "./receipts.ts";

export interface HostChangeApplierInput {
  readonly proposals: ReadonlyArray<HostChangeProposal>;
  readonly approved: ReadonlySet<HostChangeId>;
  /** The run's administrator session; needed only when an approved change has a privileged step. */
  readonly session?: PrivilegeSession;
  /** Runs unprivileged steps. */
  readonly runner?: Context.Service.Shape<typeof ProcessRunner>;
  readonly redact: (text: string) => string;
  /** Where the run records the changes it made, for uninstall to undo. */
  readonly receipts?: HostChangeReceiptStore;
}

export interface HostChangeRun {
  readonly applier: HostChangeApplier;
  /** One row per planned change, in plan order. */
  readonly outcomes: () => ReadonlyArray<HostChangeOutcome>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Receipt facts for the input each step read, so an apply-time binding stays auditable. */
const inputFacts = (inputs: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(inputs).map(([stepId, digest]) => [`stdin.${stepId}.sha256`, digest]));

const noSession = (change: HostChange) =>
  new PrivilegeUnavailableError({
    purpose: change.summary,
    message: `No administrator session is open, so Lando cannot make this change: ${change.summary}.`,
    remediation: "Rerun the command on a host where Lando can use sudo, or make this change yourself.",
  });

/** What runs a change's declared steps: the run's session, a process runner, and the redactor. */
export interface HostChangeStepDeps {
  readonly elevate?: PrivilegeSession["elevate"];
  readonly runner?: Context.Service.Shape<typeof ProcessRunner>;
  readonly redact: (text: string) => string;
}

/** What the applier learns while a change runs its steps. */
export interface HostChangeStepObserver {
  readonly privilegedSucceeded?: () => void;
  /** The SHA-256 of the input a step read. */
  readonly read?: (stepId: string, digest: string) => void;
}

/**
 * Runs only the steps `change` declared. Input must match what the plan bound it to: its planned
 * digest, or, for input bound at apply, any bytes the change checked first; root never reads
 * input the plan left unbound. Privileged steps go through `deps.elevate` and output comes back
 * redacted. Setup's applier and uninstall share it.
 */
export const hostChangeStepRunner = (
  change: HostChange,
  input: HostChangeStepDeps,
  observer: HostChangeStepObserver = {},
): HostChangeStepRunner => ({
  run: Effect.fnUntraced(function* (stepId: string, options?: { readonly stdin?: Uint8Array }) {
    const step = change.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined)
      return yield* Effect.fail(hostChangeContractError(change, `it ran undeclared step ${stepId}`));
    const stdin = options?.stdin;
    if ((step.stdin === undefined) !== (stdin === undefined)) {
      return yield* Effect.fail(
        hostChangeContractError(change, `step ${stepId} input does not match its declaration`),
      );
    }
    const digest = stdin === undefined ? undefined : sha256(stdin);
    if (digest !== undefined && step.stdin?.sha256 !== undefined && digest !== step.stdin.sha256) {
      return yield* Effect.fail(
        hostChangeContractError(change, `step ${stepId} input differs from the planned input`),
      );
    }
    if (
      digest !== undefined &&
      step.privileged &&
      step.stdin?.sha256 === undefined &&
      step.stdin?.boundAt !== "apply"
    ) {
      return yield* Effect.fail(
        hostChangeContractError(change, `step ${stepId} pipes input to root that the plan never bound`),
      );
    }
    if (digest !== undefined) observer.read?.(stepId, digest);
    const [cmd, ...args] = step.argv;
    let result: ProcessResult;
    if (step.privileged) {
      if (input.elevate === undefined) return yield* Effect.fail(noSession(change));
      result = yield* input.elevate(step.argv, stdin === undefined ? undefined : { stdin });
      if (result.exitCode === 0) observer.privilegedSucceeded?.();
    } else {
      if (input.runner === undefined) return yield* Effect.fail(noSession(change));
      result = yield* input.runner
        .run({
          cmd,
          args,
          ...(step.env === undefined ? {} : { env: step.env }),
          ...(stdin === undefined ? {} : { stdin }),
        })
        .pipe(Effect.catch((error) => Effect.succeed({ exitCode: 127, stdout: "", stderr: error.message })));
    }
    return { ...result, stdout: input.redact(result.stdout), stderr: input.redact(result.stderr) };
  }),
});

export const makeHostChangeApplier = (input: HostChangeApplierInput): HostChangeRun => {
  const stepDeps: HostChangeStepDeps = {
    ...(input.session === undefined ? {} : { elevate: input.session.elevate }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
    redact: input.redact,
  };
  const proposals = new Map(input.proposals.map((proposal) => [proposal.change.id, proposal]));
  const runs = new Map<HostChangeId, Deferred.Deferred<HostChangeOutcome, HostChangeApplyError>>();
  const recorded = new Map<HostChangeId, HostChangeOutcome>();

  const applyOnce = Effect.fnUntraced(function* (
    proposal: HostChangeProposal,
  ): Effect.fn.Return<HostChangeOutcome, HostChangeApplyError> {
    const { change } = proposal;
    const { id } = change;
    if (!input.approved.has(id)) return { id, outcome: "declined" };
    const receipts = change.undo._tag === "none" ? undefined : input.receipts;
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    let privilegedSucceeded = false;
    const inputs: Record<string, string> = {};
    const attempt = randomUUID();
    const receipt = { id, owner: change.owner, summary: change.summary, attempt, startedAt } as const;
    const settle = Effect.fnUntraced(function* (result: Omit<HostChangeApplyResult, "changed">) {
      if (receipts === undefined) return;
      const facts = { ...change.details, ...result.facts, ...inputFacts(inputs) };
      yield* receipts.write({
        operation: "record-applied",
        receipt: {
          ...receipt,
          appliedAt: DateTime.formatIso(yield* DateTime.now),
          ...(Object.keys(facts).length === 0 ? {} : { facts }),
          undo: result.undo ?? change.undo,
        },
      });
    });
    const abandon =
      receipts === undefined ? Effect.void : receipts.write({ operation: "abandon", id, attempt });
    if (receipts !== undefined) {
      yield* receipts.write({
        operation: "begin-apply",
        receipt: {
          ...receipt,
          ...(change.details === undefined ? {} : { facts: change.details }),
          undo: change.undo,
        },
      });
    }
    const exit = yield* Effect.exit(
      proposal
        .apply(
          hostChangeStepRunner(change, stepDeps, {
            privilegedSucceeded: () => {
              privilegedSucceeded = true;
            },
            read: (stepId, digest) => {
              inputs[stepId] = digest;
            },
          }),
        )
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error._tag === "HostChangeStaleError")
                recorded.set(id, { id, outcome: "stale", detail: error.reason });
            }),
          ),
        ),
    );
    if (Exit.isFailure(exit)) {
      // A change that failed after a privileged step succeeded is half made, and still Lando's.
      yield* (privilegedSucceeded ? settle({}) : abandon).pipe(Effect.ignore);
      return yield* Effect.failCause(exit.cause);
    }
    const result = exit.value;
    yield* result.changed ? settle(result) : abandon;
    return {
      id,
      outcome: result.changed ? "applied" : "already-satisfied",
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    };
  });

  const apply = (id: HostChangeId): Effect.Effect<HostChangeOutcome, HostChangeApplyError> =>
    Effect.suspend(() => {
      const started = runs.get(id);
      if (started !== undefined) return Deferred.await(started);
      const proposal = proposals.get(id);
      if (proposal === undefined) {
        return Effect.fail(
          hostChangeContractError({ id, owner: "a plugin" }, "it applied a change it never planned"),
        );
      }
      const deferred = Deferred.makeUnsafe<HostChangeOutcome, HostChangeApplyError>();
      runs.set(id, deferred);
      return applyOnce(proposal).pipe(
        Effect.tap((outcome) => Effect.sync(() => recorded.set(id, outcome))),
        Effect.onExit((exit) => Deferred.done(deferred, exit)),
      );
    });

  const outcomes = (): ReadonlyArray<HostChangeOutcome> =>
    input.proposals.map(({ change }) => {
      const outcome = recorded.get(change.id);
      if (outcome !== undefined) return outcome;
      return { id: change.id, outcome: input.approved.has(change.id) ? "skipped" : "declined" };
    });

  return {
    applier: {
      approved: (id) => (input.approved.has(id) ? proposals.get(id)?.change : undefined),
      apply,
    },
    outcomes,
  };
};
