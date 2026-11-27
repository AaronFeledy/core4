/**
 * Approve a run's planned host changes and prepare to apply them: consent first, then one
 * administrator session when an approved change runs a step as root, both before anything
 * changes. The applier records each change it makes in the user data root's receipts, so
 * `lando uninstall` can undo it. Setup and `lando doctor --fix` share it.
 */
import { type HostChangeRun, makeHostChangeApplier } from "@lando/engine/host-changes/apply";
import { privilegePurpose } from "@lando/engine/host-changes/plan";
import { makeHostChangeReceiptStore } from "@lando/engine/host-changes/receipts";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { HostChange } from "@lando/sdk/schema";
import {
  EventService,
  type HostChangeProposal,
  type InteractionServiceShape,
  type PrivilegeService,
  type PrivilegeSession,
  ProcessRunner,
  StateStore,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect, Option } from "effect";

import { CliInvocation } from "../../runtime/invocation-context";
import { resolveSecretsRedactor } from "../commands/secrets-redactor";
import { type HostChangeConsentCommand, decideHostChangeConsent } from "./consent";

export interface HostChangeApprovalInput {
  /** The command asking, which consent's questions and messages name. */
  readonly command: HostChangeConsentCommand;
  readonly proposals: ReadonlyArray<HostChangeProposal>;
  readonly yes: boolean;
  /** Opt-in flags the run was given. */
  readonly optInFlags: ReadonlySet<string>;
  /** Present only when this run may ask questions in a terminal. */
  readonly interaction: InteractionServiceShape | undefined;
  readonly privilege: Context.Service.Shape<typeof PrivilegeService> | undefined;
}

const publishWarnings = Effect.fnUntraced(function* (warnings: ReadonlyArray<string>) {
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  for (const body of warnings) {
    yield* events.value
      .publish(MessageWarnEvent.make({ body, timestamp: yield* DateTime.now }))
      .pipe(Effect.ignore);
  }
});

const sessionPurpose = (changes: ReadonlyArray<HostChange>): string =>
  privilegePurpose(changes.map((change) => change.summary));

/** Whether `interaction` may ask questions in this run, honoring `--no-interactive`. */
export const askingInteraction = Effect.fnUntraced(function* (
  interaction: InteractionServiceShape | undefined,
  nonInteractive: boolean,
) {
  if (interaction === undefined || nonInteractive) return undefined;
  return (yield* interaction.isInteractive) ? interaction : undefined;
});

export const approveHostChanges = Effect.fn("HostChanges.approve")(function* (
  input: HostChangeApprovalInput,
) {
  const changes = input.proposals.map(({ change }) => change);
  const consent = yield* decideHostChangeConsent(changes, {
    command: input.command,
    yes: input.yes,
    optInFlags: input.optInFlags,
    interaction: input.interaction,
  });
  yield* publishWarnings(consent.warnings);
  const privileged = changes.filter(
    (change) => consent.approved.has(change.id) && change.steps.some((step) => step.privileged),
  );
  let session: PrivilegeSession | undefined;
  if (privileged.length > 0 && input.privilege !== undefined) {
    session = yield* input.privilege.openSession(sessionPurpose(privileged));
  }
  const runner = yield* Effect.serviceOption(ProcessRunner);
  const store = yield* Effect.serviceOption(StateStore);
  const { redact } = yield* resolveSecretsRedactor({ sourceEnv: (yield* CliInvocation).env });
  const run: HostChangeRun = makeHostChangeApplier({
    proposals: input.proposals,
    approved: consent.approved,
    ...(session === undefined ? {} : { session }),
    ...(Option.isNone(runner) ? {} : { runner: runner.value }),
    ...(Option.isNone(store) ? {} : { receipts: makeHostChangeReceiptStore(store.value) }),
    redact,
  });
  return run;
});
