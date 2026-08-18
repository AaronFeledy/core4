/**
 * Safe-mode `lando doctor` entry point.
 *
 * `meta:doctor` bootstraps at `none` and builds the `provider` runtime here,
 * inside the doctor program, so a bootstrap failure becomes a
 * `provider-bootstrap` self check in an otherwise normal report instead of
 * leaving the user with no diagnostics. Every other command keeps failing loudly
 * on a bad plugin graph or unreadable config, which is the correct behavior for
 * them.
 *
 * The runtime is built exactly once, inside a `Scope` that stays open for the
 * runtime-dependent sections and closes with the report.
 */
import { Effect, Layer, Option } from "effect";

import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { ConfigServiceLive } from "@lando/engine/services/config";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { type DoctorOptions, doctor } from "./doctor";
import { interruptOnAbort } from "./doctor-abort";
import { UNRESOLVED_CERTS_STATUS, certsDoctorStatus } from "./doctor-certs-status";
import { collectDoctorReport, doctorDeprecations } from "./doctor-report";
import type { DoctorReport } from "./doctor-report-contract";
import { type DoctorSelfSolution, doctorSectionBudgetMs, isolateDoctorSection } from "./doctor-self";

const BOOTSTRAP_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Lando could not start its provider runtime, so provider diagnostics were skipped. This is usually an unreadable `config.yml` or a conflicting installed plugin: check `lando config view` and `lando plugin list`.",
  command: "lando config view",
};

export const resilientDoctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, never, RuntimeLayerFactory> =>
  interruptOnAbort(collectResilientDoctorReport(options), options.signal);

const collectResilientDoctorReport = (
  options: DoctorOptions,
): Effect.Effect<DoctorReport, never, RuntimeLayerFactory> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sourceEnv = { ...(options.env ?? process.env) };
      const redactionService = yield* Effect.serviceOption(RedactionService);
      const redactor = Option.isSome(redactionService)
        ? yield* redactionService.value.forProfile("secrets", { sourceEnv })
        : createStandaloneRedactor("secrets", { sourceEnv });

      const runtimeLayerFactory = yield* RuntimeLayerFactory;
      const runtime = runtimeLayerFactory.make(
        cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } }),
      );
      const built = yield* isolateDoctorSection({
        section: "provider-bootstrap",
        effect: Layer.build(runtime),
        fallback: undefined,
        budgetMs: doctorSectionBudgetMs(sourceEnv),
        redact: (value) => redactor.redactString(value),
        solutions: [BOOTSTRAP_REMEDIATION],
      });
      const context = built.value;

      // `ConfigServiceLive` is a pure `Layer.succeed`, so providing it here
      // cannot fail even when the full runtime could not be built.
      return yield* collectDoctorReport({
        options,
        certs:
          context === undefined
            ? Effect.succeed(UNRESOLVED_CERTS_STATUS)
            : certsDoctorStatus(redactor.redactString).pipe(Effect.provide(context)),
        provider:
          context === undefined
            ? Effect.succeed({ checks: [] })
            : doctor(options).pipe(Effect.provide(context)),
        deprecations:
          context === undefined
            ? Effect.succeed({ entries: [] })
            : doctorDeprecations().pipe(Effect.provide(context)),
        ...(built.self === undefined ? {} : { initialSelfChecks: [built.self] }),
      }).pipe(Effect.provide(ConfigServiceLive));
    }),
  );
