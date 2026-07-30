import { sep } from "node:path";

import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";

import { ToolingExecError } from "../errors/index.ts";
import type { AppPlan } from "../schema/index.ts";
import type { RuntimeProviderShape, ToolingEngineResult, ToolingInvocation } from "../services/index.ts";
import { ContractFailure, isNonEmptyString } from "./_shared.ts";

const stableUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableUnknown);
  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, stableUnknown(entry)]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableUnknown(entry)]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(stableUnknown(value));

// ---------------------------------------------------------------------------
// Doctor check contract suite
// ---------------------------------------------------------------------------

/** A remediation a doctor issue carries — either an automatic command or manual steps. */
export type DoctorCheckSolutionKind = "automatic" | "manual";

/** A single issue reported by a doctor check. */
export interface DoctorCheckIssue {
  /** Issue severity. */
  readonly severity: "info" | "warning" | "error";
  /** Structured context describing what was inspected. */
  readonly context: Readonly<Record<string, string>>;
  /** The remediation kind. */
  readonly solutionKind: DoctorCheckSolutionKind;
  /** Human-readable solution description. */
  readonly solution: string;
  /** Automatic solution command (present only for `automatic` solutions). */
  readonly command?: string;
}

/** Result of running a doctor check. SDK-test-local (no `doctorChecks:` SDK surface yet). */
export interface DoctorCheckResult {
  /** The check id. */
  readonly id: string;
  /** Issues found (empty = healthy). */
  readonly issues: ReadonlyArray<DoctorCheckIssue>;
}

/**
 * Raised by a doctor check `run` when the check cannot execute. SDK-test-local:
 * doctor checks are not a published plugin contribution surface yet, so this tagged error lives
 * with the contract suite rather than `@lando/sdk/errors`.
 */
export class DoctorCheckError extends Schema.TaggedError<DoctorCheckError>()("DoctorCheckError", {
  message: Schema.String,
  check: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

const doctorCheckContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `Doctor check contract failed: ${assertion}`, assertion, details });

const requireDoctorCheckContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(doctorCheckContractFailure(assertion, details));

/**
 * Drives any doctor check (the built-in core checks or a `doctorChecks:`
 * contribution) through the published doctor-check contract: `run()` returns
 * issues carrying severity / context and an automatic|manual solution; default
 * runs are read-only and only `--fix` executes automatic solutions; shell-shaped
 * probes route through `ShellRunner` (so they appear in the redacted doctor
 * transcript); and secrets are redacted. `check` is required; the
 * remaining fields are optional probes asserted only when supplied.
 */
export interface DoctorCheckContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The check under test. */
  readonly check: {
    readonly id: string;
    readonly run: (input: { readonly fix: boolean }) => Effect.Effect<DoctorCheckResult, DoctorCheckError>;
  };
  /** Optional: the issue shape `run({ fix: false })` must report. */
  readonly expectedIssue?: {
    readonly severity: "info" | "warning" | "error";
    readonly contextKey?: string;
    readonly solutionKind: DoctorCheckSolutionKind;
  };
  /**
   * Optional: snapshot/assert pair proving a default `run({ fix: false })`
   * performed no mutation.
   */
  readonly readOnlyProbe?: {
    readonly snapshot: Effect.Effect<unknown>;
    readonly assertUnchanged: (before: unknown) => Effect.Effect<boolean>;
  };
  /**
   * Optional: asserts `run({ fix: true })` executed an automatic solution
   * (returns whether the fix ran).
   */
  readonly fixProbe?: Effect.Effect<boolean>;
  /**
   * Optional: returns the redacted transcript lines produced by the check's
   * shell-shaped probes (proving they routed through `ShellRunner`).
   */
  readonly shellRunnerProbe?: Effect.Effect<ReadonlyArray<string>>;
  /** Optional: a secret value that must be absent from the redacted transcript. */
  readonly secretValue?: string;
  /** Optional: the rendered transcript string the secret must not appear in. */
  readonly redactedTranscriptProbe?: Effect.Effect<string>;
}

export const runDoctorCheckContractSuite = (
  harness: DoctorCheckContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.check.id;

    yield* requireDoctorCheckContract(
      isNonEmptyString(harness.check.id),
      `${label}: check exposes a non-empty id`,
      harness.check.id,
    );

    const readOnlyBaseline =
      harness.readOnlyProbe === undefined ? undefined : yield* harness.readOnlyProbe.snapshot;

    // --- default run returns issues carrying severity/context + a solution ---
    const result = yield* harness.check
      .run({ fix: false })
      .pipe(
        Effect.mapError((cause) =>
          doctorCheckContractFailure(`${label}: run({ fix: false }) resolves`, cause),
        ),
      );
    yield* requireDoctorCheckContract(
      Array.isArray(result.issues),
      `${label}: run returns a DoctorCheckResult with an issues array`,
      result,
    );
    for (const issue of result.issues) {
      yield* requireDoctorCheckContract(
        issue.severity === "info" || issue.severity === "warning" || issue.severity === "error",
        `${label}: each issue carries a valid severity`,
        issue,
      );
      yield* requireDoctorCheckContract(
        typeof issue.context === "object" && issue.context !== null,
        `${label}: each issue carries structured context`,
        issue,
      );
      yield* requireDoctorCheckContract(
        issue.solutionKind === "automatic" || issue.solutionKind === "manual",
        `${label}: each issue carries an automatic or manual solution`,
        issue,
      );
      if (issue.solutionKind === "automatic") {
        yield* requireDoctorCheckContract(
          isNonEmptyString(issue.command),
          `${label}: an automatic solution carries a command`,
          issue,
        );
      }
    }

    if (harness.expectedIssue) {
      const expected = harness.expectedIssue;
      const match = result.issues.find(
        (issue) =>
          issue.severity === expected.severity &&
          issue.solutionKind === expected.solutionKind &&
          (expected.contextKey === undefined || expected.contextKey in issue.context),
      );
      yield* requireDoctorCheckContract(
        match !== undefined,
        `${label}: run reports an issue matching the expected shape`,
        { expected, issues: result.issues },
      );
    }

    // --- optional: default run is read-only ---
    if (harness.readOnlyProbe) {
      yield* harness.check
        .run({ fix: false })
        .pipe(
          Effect.mapError((cause) =>
            doctorCheckContractFailure(`${label}: read-only probe run resolves`, cause),
          ),
        );
      const unchanged = yield* harness.readOnlyProbe.assertUnchanged(readOnlyBaseline);
      yield* requireDoctorCheckContract(
        unchanged,
        `${label}: default run({ fix: false }) performs no mutation`,
        readOnlyBaseline,
      );
    }

    // --- optional: --fix executes automatic solutions ---
    if (harness.fixProbe) {
      yield* harness.check
        .run({ fix: true })
        .pipe(
          Effect.mapError((cause) =>
            doctorCheckContractFailure(`${label}: run({ fix: true }) resolves`, cause),
          ),
        );
      const fixed = yield* harness.fixProbe;
      yield* requireDoctorCheckContract(
        fixed,
        `${label}: run({ fix: true }) executes the automatic solution`,
        fixed,
      );
    }

    // --- optional: shell-shaped probes route through ShellRunner (transcript evidence) ---
    if (harness.shellRunnerProbe) {
      const transcript = yield* harness.shellRunnerProbe;
      yield* requireDoctorCheckContract(
        transcript.length > 0,
        `${label}: shell-shaped probes appear in the doctor transcript via ShellRunner`,
        transcript,
      );
    }

    // --- optional: secrets are redacted from the transcript ---
    if (harness.redactedTranscriptProbe && isNonEmptyString(harness.secretValue)) {
      const transcript = yield* harness.redactedTranscriptProbe;
      yield* requireDoctorCheckContract(
        !transcript.includes(harness.secretValue),
        `${label}: the redacted transcript never contains a raw secret value`,
        { transcript },
      );
    }
  });

export const makeDoctorCheckContractSuite = runDoctorCheckContractSuite;

// ---------------------------------------------------------------------------
// ToolingEngine contract suite
// ---------------------------------------------------------------------------

const toolingEngineContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ToolingEngine contract failed: ${assertion}`, assertion, details });

const requireToolingEngineContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(toolingEngineContractFailure(assertion, details));

/** Minimal structural view of a `ToolingEngine` the contract suite drives. */
export interface ToolingEngineUnderTest {
  /** The engine id (e.g. `providerExec`, `host`). */
  readonly id: string;
  /** Translate an invocation into a single aggregated result. */
  readonly run: (
    invocation: ToolingInvocation,
    plan: AppPlan,
    provider: RuntimeProviderShape,
  ) => Effect.Effect<ToolingEngineResult, unknown>;
}

/**
 * Drives any `ToolingEngine` through the published execution contract: a
 * non-empty id, an `Effect`-typed `run`, ordered sequential command execution,
 * a first-non-zero-exit short-circuit that returns an aggregated non-zero
 * result, deterministic output for the same scenario, and a tagged
 * `ToolingExecError` (carrying the failing task id) for launch/validation
 * failures supplied by `execErrorScenario`. `engine`, `okScenario`, and
 * `failScenario` are required; the remaining fields are optional probes asserted
 * only when the harness supplies the hook. The harness owns the
 * `AppPlan`/`RuntimeProviderShape` doubles so the suite never contacts a real
 * provider.
 */
export interface ToolingEngineContractHarness {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The engine under test. */
  readonly engine: ToolingEngineUnderTest;
  /**
   * A scenario whose every command exits zero. The suite asserts ordered
   * execution, the captured command sequence, and the aggregated result.
   */
  readonly okScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    /**
     * Build a fresh recording provider for one run. `record` returns, in
     * execution order, the argv of every command the engine handed to the
     * provider (or host) so the suite can assert sequencing.
     */
    readonly makeProvider: () => {
      readonly provider: RuntimeProviderShape;
      readonly record: () => ReadonlyArray<ReadonlyArray<string>>;
    };
    /** The exact aggregated result the engine must produce. */
    readonly expected: ToolingEngineResult;
    /** The exact ordered argv sequence the engine must have executed. */
    readonly expectedCommands: ReadonlyArray<ReadonlyArray<string>>;
  };
  /**
   * A scenario whose Nth command exits non-zero. The suite asserts the engine
   * stops at the first failure and that the result carries that exit code.
   */
  readonly failScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly makeProvider: () => {
      readonly provider: RuntimeProviderShape;
      readonly record: () => ReadonlyArray<ReadonlyArray<string>>;
    };
    /** The non-zero exit code the aggregated result must report. */
    readonly expectedExitCode: number;
    /** The number of commands that must have executed before the short-circuit. */
    readonly expectedCommandCount: number;
  };
  /**
   * A scenario that fails `run` with a tagged `ToolingExecError`. The suite
   * asserts the error carries the invocation's `tool` (the failing task id).
   */
  readonly execErrorScenario: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
  };
  /**
   * Optional: declared capabilities and observed behavior tags. When supplied,
   * the suite asserts they match (sorted equality).
   */
  readonly capabilities?: ReadonlyArray<string>;
  /** Optional: observed behavior tags compared against {@link capabilities}. */
  readonly behaviorTags?: ReadonlyArray<string>;
  /**
   * Optional: an interruption probe. `run` must be a long-running effect the
   * suite can `Effect.interrupt`; `assertFinalized` reports whether the in-flight
   * work was finalized (no orphaned child) after the interrupt.
   */
  readonly interruptionProbe?: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly provider: RuntimeProviderShape;
    readonly assertFinalized: Effect.Effect<boolean>;
  };
  /**
   * Optional: a redaction probe proving a secret value supplied through the
   * invocation never survives in the aggregated result output.
   */
  readonly redactionProbe?: {
    readonly invocation: ToolingInvocation;
    readonly plan: AppPlan;
    readonly makeProvider: () => { readonly provider: RuntimeProviderShape };
    readonly secretValue: string;
    /** Extract the rendered output the secret must be absent from. */
    readonly render: (result: ToolingEngineResult) => string;
  };
}

export const runToolingEngineContractSuite = (
  harness: ToolingEngineContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.engine.id;
    const engine = harness.engine;

    yield* requireToolingEngineContract(
      isNonEmptyString(engine.id),
      `${label}: engine exposes a non-empty id`,
      engine.id,
    );
    yield* requireToolingEngineContract(
      Effect.isEffect(
        engine.run(
          harness.okScenario.invocation,
          harness.okScenario.plan,
          harness.okScenario.makeProvider().provider,
        ),
      ),
      `${label}: run is Effect-typed`,
    );

    // --- ordered sequential execution + aggregated result ---
    const okRun = harness.okScenario.makeProvider();
    const okResult = yield* engine
      .run(harness.okScenario.invocation, harness.okScenario.plan, okRun.provider)
      .pipe(
        Effect.mapError((cause) => toolingEngineContractFailure(`${label}: ok scenario run resolves`, cause)),
      );
    yield* requireToolingEngineContract(
      stableJson(okResult) === stableJson(harness.okScenario.expected),
      `${label}: run produces the expected aggregated result`,
      { actual: okResult, expected: harness.okScenario.expected },
    );
    yield* requireToolingEngineContract(
      stableJson(okRun.record()) === stableJson(harness.okScenario.expectedCommands),
      `${label}: run executes commands in declared order`,
      { actual: okRun.record(), expected: harness.okScenario.expectedCommands },
    );

    // --- determinism across repeated runs of the same scenario ---
    const okRunAgain = harness.okScenario.makeProvider();
    const okResultAgain = yield* engine
      .run(harness.okScenario.invocation, harness.okScenario.plan, okRunAgain.provider)
      .pipe(
        Effect.mapError((cause) =>
          toolingEngineContractFailure(`${label}: repeat ok scenario run resolves`, cause),
        ),
      );
    yield* requireToolingEngineContract(
      stableJson(okResult) === stableJson(okResultAgain),
      `${label}: run is deterministic for the same scenario`,
      { first: okResult, second: okResultAgain },
    );

    // --- first non-zero exit short-circuits the remaining commands ---
    const failRun = harness.failScenario.makeProvider();
    const failResult = yield* engine
      .run(harness.failScenario.invocation, harness.failScenario.plan, failRun.provider)
      .pipe(
        Effect.mapError((cause) =>
          toolingEngineContractFailure(`${label}: fail scenario run resolves with a non-zero result`, cause),
        ),
      );
    yield* requireToolingEngineContract(
      failResult.exitCode === harness.failScenario.expectedExitCode,
      `${label}: run reports the failing command's exit code`,
      { actual: failResult.exitCode, expected: harness.failScenario.expectedExitCode },
    );
    yield* requireToolingEngineContract(
      failRun.record().length === harness.failScenario.expectedCommandCount,
      `${label}: run stops at the first non-zero exit`,
      { actual: failRun.record().length, expected: harness.failScenario.expectedCommandCount },
    );

    // --- a failed launch maps to a tagged ToolingExecError carrying the tool id ---
    const execErrorExit = yield* Effect.exit(
      engine.run(
        harness.execErrorScenario.invocation,
        harness.execErrorScenario.plan,
        harness.execErrorScenario.provider,
      ),
    );
    yield* requireToolingEngineContract(
      Exit.isFailure(execErrorExit),
      `${label}: exec-error scenario fails`,
      execErrorExit,
    );
    if (Exit.isFailure(execErrorExit)) {
      const failure = Cause.failureOption(execErrorExit.cause);
      yield* requireToolingEngineContract(
        Option.isSome(failure) && failure.value instanceof ToolingExecError,
        `${label}: failure is a tagged ToolingExecError`,
        execErrorExit.cause,
      );
      if (Option.isSome(failure) && failure.value instanceof ToolingExecError) {
        yield* requireToolingEngineContract(
          failure.value.tool === harness.execErrorScenario.invocation.tool,
          `${label}: ToolingExecError carries the failing task id`,
          { actual: failure.value.tool, expected: harness.execErrorScenario.invocation.tool },
        );
      }
    }

    // --- optional: capability declaration matches observed behavior ---
    if (harness.capabilities && harness.behaviorTags) {
      const declared = [...harness.capabilities].sort();
      const observed = [...harness.behaviorTags].sort();
      yield* requireToolingEngineContract(
        JSON.stringify(declared) === JSON.stringify(observed),
        `${label}: declared capabilities match observed behavior`,
        { declared, observed },
      );
    }

    // --- optional: interruption cancels in-flight work and finalizes children ---
    if (harness.interruptionProbe) {
      const probe = harness.interruptionProbe;
      const fiber = yield* Effect.fork(
        engine.run(probe.invocation, probe.plan, probe.provider).pipe(Effect.either),
      );
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(fiber);
      const finalized = yield* probe.assertFinalized;
      yield* requireToolingEngineContract(
        finalized === true,
        `${label}: interruption finalizes in-flight work (no orphaned child)`,
        { finalized },
      );
    }

    // --- optional: a secret-resolved value never reaches the result output ---
    if (harness.redactionProbe) {
      const probe = harness.redactionProbe;
      const result = yield* engine
        .run(probe.invocation, probe.plan, probe.makeProvider().provider)
        .pipe(
          Effect.mapError((cause) =>
            toolingEngineContractFailure(`${label}: redaction scenario run resolves`, cause),
          ),
        );
      const rendered = probe.render(result);
      yield* requireToolingEngineContract(
        !rendered.includes(probe.secretValue),
        `${label}: secret-resolved values never reach the result output`,
        { rendered },
      );
    }
  });

export const makeToolingEngineContractSuite = runToolingEngineContractSuite;

// ---------------------------------------------------------------------------
// PluginSource contract suite
// ---------------------------------------------------------------------------

/** A tagged error a plugin-source resolution may fail with. */
export interface PluginSourceTaggedError {
  readonly _tag: string;
  readonly message: string;
  readonly remediation?: string;
}

const pluginSourceContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `PluginSource contract failed: ${assertion}`, assertion, details });

const requirePluginSourceContract = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(pluginSourceContractFailure(assertion, details));

/**
 * Drives any `PluginSource` through the published resolution contract: a
 * non-empty id, a `resolve(spec)` that yields a package root contained under a
 * Lando-managed store after realpath resolution, an escaping spec that fails
 * with a tagged error carrying remediation, and deterministic resolution.
 * Because the built-in source adapters land with `lando plugin:add`, the
 * containment behavior is supplied through the harness `resolve` probe (modeling
 * the real registry containment guarantee) rather than read off the bare SDK
 * tag. `source`, `managedStoreRoot`, `containedSpec`, and `escapingSpec` are
 * required; `network`/`auth`/`offline` are optional probes.
 */
export interface PluginSourceContractHarness<Spec> {
  /** Optional label woven into failure messages. */
  readonly name?: string;
  /** The source under test (the bare SDK tag value plus a resolve probe). */
  readonly source: { readonly id: string };
  /**
   * Resolve a spec to an absolute, realpath-resolved package root, or fail with
   * a tagged error. Models the containment guarantee the built-in registry
   * enforces today (and future source adapters will satisfy directly).
   */
  readonly resolve: (spec: Spec) => Effect.Effect<string, PluginSourceTaggedError>;
  /** The absolute, realpath-resolved Lando-managed store the root must stay under. */
  readonly managedStoreRoot: string;
  /** A spec that resolves to a package root contained under the managed store. */
  readonly containedSpec: Spec;
  /** A spec that escapes the managed store (via `..`/symlink) and must fail. */
  readonly escapingSpec: Spec;
  /**
   * Optional: a probe proving resolution honored `network.proxy`/`network.ca`.
   * Returns the network trust values observed during a resolve.
   */
  readonly networkTrustProbe?: {
    readonly resolve: Effect.Effect<unknown, PluginSourceTaggedError>;
    readonly observed: Effect.Effect<{ readonly proxy?: string; readonly ca?: string }>;
    readonly expected: { readonly proxy?: string; readonly ca?: string };
  };
  /**
   * Optional: a registry-auth token plus the rendered log/event output it must
   * be absent from after a resolve.
   */
  readonly authRedactionProbe?: {
    readonly token: string;
    readonly renderedOutput: Effect.Effect<string>;
  };
  /**
   * Optional: an already-locked spec that must resolve offline without a
   * re-fetch. `fetchCount` reports how many times the network was contacted.
   */
  readonly offlineLockedProbe?: {
    readonly spec: Spec;
    readonly resolve: (spec: Spec) => Effect.Effect<string, PluginSourceTaggedError>;
    readonly fetchCount: Effect.Effect<number>;
  };
}

export const runPluginSourceContractSuite = <Spec>(
  harness: PluginSourceContractHarness<Spec>,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const label = harness.name ?? harness.source.id;

    yield* requirePluginSourceContract(
      isNonEmptyString(harness.source.id),
      `${label}: source exposes a non-empty id`,
      harness.source.id,
    );

    // --- a contained spec resolves to a realpath under the managed store ---
    const contained = yield* harness
      .resolve(harness.containedSpec)
      .pipe(
        Effect.mapError((cause) => pluginSourceContractFailure(`${label}: contained spec resolves`, cause)),
      );
    const root = harness.managedStoreRoot;
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    yield* requirePluginSourceContract(
      contained === root || contained.startsWith(prefix),
      `${label}: resolved root stays under the managed store after realpath`,
      { resolved: contained, managedStoreRoot: root },
    );

    // --- resolution is deterministic ---
    const containedAgain = yield* harness
      .resolve(harness.containedSpec)
      .pipe(
        Effect.mapError((cause) =>
          pluginSourceContractFailure(`${label}: repeat contained spec resolves`, cause),
        ),
      );
    yield* requirePluginSourceContract(
      contained === containedAgain,
      `${label}: resolution is deterministic for the same spec`,
      { first: contained, second: containedAgain },
    );

    // --- an escaping spec fails with a tagged error carrying remediation ---
    const escapeExit = yield* Effect.exit(harness.resolve(harness.escapingSpec));
    yield* requirePluginSourceContract(
      Exit.isFailure(escapeExit),
      `${label}: escaping spec fails`,
      escapeExit,
    );
    if (Exit.isFailure(escapeExit)) {
      const failure = Cause.failureOption(escapeExit.cause);
      yield* requirePluginSourceContract(
        Option.isSome(failure) && typeof (failure.value as { _tag?: unknown })._tag === "string",
        `${label}: escape failure is a tagged error (carries _tag)`,
        escapeExit.cause,
      );
      if (Option.isSome(failure)) {
        const remediation = (failure.value as { remediation?: unknown }).remediation;
        yield* requirePluginSourceContract(
          typeof remediation === "string" && remediation.length > 0,
          `${label}: escape failure carries remediation`,
          failure.value,
        );
      }
    }

    // --- optional: resolution honored network.proxy/network.ca ---
    if (harness.networkTrustProbe) {
      const probe = harness.networkTrustProbe;
      yield* probe.resolve.pipe(
        Effect.mapError((cause) =>
          pluginSourceContractFailure(`${label}: network-trust resolve resolves`, cause),
        ),
      );
      const observed = yield* probe.observed;
      yield* requirePluginSourceContract(
        observed.proxy === probe.expected.proxy && observed.ca === probe.expected.ca,
        `${label}: resolution honored network.proxy/network.ca`,
        { observed, expected: probe.expected },
      );
    }

    // --- optional: registry auth tokens are redacted from logs/events ---
    if (harness.authRedactionProbe) {
      const probe = harness.authRedactionProbe;
      const rendered = yield* probe.renderedOutput;
      yield* requirePluginSourceContract(
        !rendered.includes(probe.token),
        `${label}: registry auth token is redacted from logs/events`,
        { rendered },
      );
    }

    // --- optional: already-locked sources resolve offline without re-fetch ---
    if (harness.offlineLockedProbe) {
      const probe = harness.offlineLockedProbe;
      yield* probe
        .resolve(probe.spec)
        .pipe(
          Effect.mapError((cause) =>
            pluginSourceContractFailure(`${label}: offline-locked resolve resolves`, cause),
          ),
        );
      const fetches = yield* probe.fetchCount;
      yield* requirePluginSourceContract(
        fetches === 0,
        `${label}: already-locked source resolves offline without a re-fetch`,
        { fetches },
      );
    }
  });

export const makePluginSourceContractSuite = runPluginSourceContractSuite;
