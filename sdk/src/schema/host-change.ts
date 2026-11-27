import { Schema } from "effect";

// ============================================================================
// Host changes — privileged or host-global changes Lando plans, shows, applies, and undoes.
// ============================================================================

export const HostChangeId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u))
  .pipe(Schema.brand("HostChangeId"))
  .annotate({
    description:
      "Stable `<owner>:<change>` identifier, where `<owner>` is the owning package name without its scope, for example `provider-lando:enable-linger`.",
  });
export type HostChangeId = typeof HostChangeId.Type;

export const HostChangeStage = Schema.Literals(["lando-roots", "provider", "ca", "proxy"]).annotate({
  description: "The setup stage that applies the change.",
});
export type HostChangeStage = typeof HostChangeStage.Type;

export const HostChangeConsent = Schema.Literals(["standard", "separate", "interactive-only"]).annotate({
  description:
    "`standard`: approved by `--yes` or one confirmation shared with the other standard changes. `separate`: its own confirmation or its opt-in flag; `--yes` never approves it. `interactive-only`: offered only as a question in a terminal.",
});
export type HostChangeConsent = typeof HostChangeConsent.Type;

export const HostChangeRequirement = Schema.Literals(["required", "recommended"]).annotate({
  description:
    "`required`: setup cannot finish without it, so declining fails setup. `recommended`: declining skips it with a warning.",
});
export type HostChangeRequirement = typeof HostChangeRequirement.Type;

export const HostChangeStepId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u));

export const HostChangeStep = Schema.Struct({
  id: HostChangeStepId,
  summary: Schema.String,
  argv: Schema.NonEmptyArray(Schema.String).annotate({
    description: "The exact command. A privileged step's first element is an absolute path.",
  }),
  privileged: Schema.Boolean,
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Environment for an unprivileged step. Privileged steps never carry one.",
    }),
  ),
  stdin: Schema.optionalKey(
    Schema.Struct({
      summary: Schema.String,
      sha256: Schema.optionalKey(
        Schema.String.annotate({
          description: "Digest of the input known at plan time; the step refuses any other input.",
        }),
      ),
      boundAt: Schema.optionalKey(
        Schema.Literal("apply").annotate({
          description:
            "The input does not exist at plan time (a privileged step then needs `verifiedBy`). The change checks it as `verifiedBy` says before the step runs, and the run records the digest it read.",
        }),
      ),
      verifiedBy: Schema.optionalKey(
        Schema.NonEmptyString.annotate({
          description: "How the change checks input bound at apply, shown with the plan.",
        }),
      ),
    }).annotate({
      description:
        "Input piped to the command, described rather than shown. A privileged step's input is bound to the approval by its plan-time digest, or by `boundAt: apply` with `verifiedBy`.",
    }),
  ),
  when: Schema.Literals(["always", "if-needed"]).annotate({
    description: "`if-needed`: runs only when an earlier step left the change incomplete.",
  }),
});
export type HostChangeStep = typeof HostChangeStep.Type;

export const HostChangeUndo = Schema.Union([
  Schema.TaggedStruct("steps", {
    consent: HostChangeConsent,
    summary: Schema.String,
    steps: Schema.NonEmptyArray(HostChangeStep),
  }),
  Schema.TaggedStruct("manual", { detail: Schema.String }),
  Schema.TaggedStruct("none", { detail: Schema.String }),
]).annotate({
  description: "How the change is undone: exact steps, a manual instruction, or nothing to undo.",
});
export type HostChangeUndo = typeof HostChangeUndo.Type;

export const HostChange = Schema.Struct({
  id: HostChangeId,
  owner: Schema.String.annotate({ description: "Package that planned the change, or `@lando/core`." }),
  stage: HostChangeStage,
  summary: Schema.String.annotate({ description: "What the change does, as a short imperative phrase." }),
  reason: Schema.String.annotate({ description: "Why Lando needs the change." }),
  consent: HostChangeConsent,
  optInFlag: Schema.optionalKey(
    Schema.String.annotate({
      description: "Setup flag that approves a `separate` change, for example `enable-linger`.",
    }),
  ),
  persistent: Schema.Boolean.annotate({
    description: "The change keeps altering host behavior outside Lando, as lingering does.",
  }),
  requirement: HostChangeRequirement,
  details: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "Facts the plan observed, such as the user, the range, or the file path.",
    }),
  ),
  steps: Schema.NonEmptyArray(HostChangeStep).annotate({ description: "The exact commands, in order." }),
  manual: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "How a person makes the same change by hand, as commands they can run. Required when a step reads input on stdin, which a person cannot type after the command.",
    }),
  ),
  undo: HostChangeUndo,
}).annotate({ description: "One host change Lando plans before it changes anything." });
export type HostChange = typeof HostChange.Type;

export const HostChangeApproval = Schema.Literals([
  "approved",
  "will-ask",
  "will-skip",
  "blocked",
  "not-offered",
]).annotate({
  description:
    "What this run does with the change, given its flags and terminal. `approved`: applies it without asking. `will-ask`: asks in the terminal. `will-skip`: skips it, a recommended change, with a warning. `blocked`: cannot approve it, a required change, so the run fails before changing anything. `not-offered`: cannot offer it at all.",
});
export type HostChangeApproval = typeof HostChangeApproval.Type;

export const HostChangePlanEntry = Schema.Struct({
  change: HostChange,
  approval: HostChangeApproval,
  approvedBy: Schema.Array(Schema.String).annotate({
    description:
      "The flags that approve the change in a run that does not ask: `--yes` for a standard change, its opt-in flag (such as `--enable-linger`) for a separate one, none for a change only a terminal can approve.",
  }),
}).annotate({
  description: "One planned host change and what this run would do with it.",
});
export type HostChangePlanEntry = typeof HostChangePlanEntry.Type;

export const HostChangeOutcomeKind = Schema.Literals([
  "applied",
  "already-satisfied",
  "declined",
  "skipped",
  "stale",
]).annotate({
  description:
    "`applied`: Lando made the change. `already-satisfied`: the host already had it. `declined`: not approved. `skipped`: approved, but its stage did not run it. `stale`: the host changed after planning, so nothing ran.",
});
export type HostChangeOutcomeKind = typeof HostChangeOutcomeKind.Type;

export const HostChangeOutcome = Schema.Struct({
  id: HostChangeId,
  outcome: HostChangeOutcomeKind,
  detail: Schema.optionalKey(Schema.String.annotate({ description: "Why, for a stale change." })),
  inputs: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description: "The SHA-256 of the input each step read, by step id.",
    }),
  ),
}).annotate({ description: "What one run did with one planned host change." });
export type HostChangeOutcome = typeof HostChangeOutcome.Type;
