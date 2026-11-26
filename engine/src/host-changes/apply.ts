/**
 * Applies one run's approved host changes. A change runs only the steps it declared, a declared
 * input digest is checked before its step runs, privileged steps go through the run's single
 * administrator session, and each change applies at most once per run. Step output reaches the
 * proposal redacted. The applier publishes nothing, so it never opens a task tree of its own.
 */
import { createHash } from "node:crypto";

import { PrivilegeUnavailableError } from "@lando/sdk/errors";
import type { HostChange, HostChangeId, HostChangeOutcome } from "@lando/sdk/schema";
import type {
  HostChangeApplier,
  HostChangeApplyError,
  HostChangeProposal,
  HostChangeStepRunner,
  PrivilegeSession,
  ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { type Context, Deferred, Effect } from "effect";

import { hostChangeContractError } from "./plan.ts";

export interface HostChangeApplierInput {
  readonly proposals: ReadonlyArray<HostChangeProposal>;
  readonly approved: ReadonlySet<HostChangeId>;
  /** The run's administrator session; needed only when an approved change has a privileged step. */
  readonly session?: PrivilegeSession;
  /** Runs unprivileged steps. */
  readonly runner?: Context.Service.Shape<typeof ProcessRunner>;
  readonly redact: (text: string) => string;
}

export interface HostChangeRun {
  readonly applier: HostChangeApplier;
  /** One row per planned change, in plan order. */
  readonly outcomes: () => ReadonlyArray<HostChangeOutcome>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const noSession = (change: HostChange) =>
  new PrivilegeUnavailableError({
    purpose: change.summary,
    message: `No administrator session is open, so Lando cannot make this change: ${change.summary}.`,
    remediation: "Rerun `lando setup` on a host where Lando can use sudo, or make this change yourself.",
  });

/**
 * Runs only the steps `change` declared. Input must match what the plan bound it to: its planned
 * digest, or, for input bound at apply, any bytes the change checked first; either way
 * `onInput` gets the digest of what the step read.
 */
const stepRunner = (
  change: HostChange,
  input: HostChangeApplierInput,
  onInput: (stepId: string, digest: string) => void,
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
    if (digest !== undefined) onInput(stepId, digest);
    const [cmd, ...args] = step.argv;
    let result: ProcessResult;
    if (step.privileged) {
      if (input.session === undefined) return yield* Effect.fail(noSession(change));
      result = yield* input.session.elevate(step.argv, stdin === undefined ? undefined : { stdin });
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
  const proposals = new Map(input.proposals.map((proposal) => [proposal.change.id, proposal]));
  const runs = new Map<HostChangeId, Deferred.Deferred<HostChangeOutcome, HostChangeApplyError>>();
  const recorded = new Map<HostChangeId, HostChangeOutcome>();

  const applyOnce = Effect.fnUntraced(function* (
    proposal: HostChangeProposal,
  ): Effect.fn.Return<HostChangeOutcome, HostChangeApplyError> {
    const { id } = proposal.change;
    if (!input.approved.has(id)) return { id, outcome: "declined" };
    const inputs: Record<string, string> = {};
    const record = (stepId: string, digest: string) => {
      inputs[stepId] = digest;
    };
    const result = yield* proposal.apply(stepRunner(proposal.change, input, record)).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === "HostChangeStaleError")
            recorded.set(id, { id, outcome: "stale", detail: error.reason });
        }),
      ),
    );
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
