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

import { RedactionService, createStandaloneRedactor } from "../../redaction/service.ts";
import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { ConfigServiceLive } from "../../services/config.ts";
import type { DoctorReport } from "./doctor-report-contract.ts";
import { collectDoctorReport, doctorDeprecations } from "./doctor-report.ts";
import { type DoctorSelfSolution, isolateDoctorSection } from "./doctor-self.ts";
import { type DoctorOptions, doctor } from "./doctor.ts";

const BOOTSTRAP_REMEDIATION: DoctorSelfSolution = {
  kind: "manual",
  description:
    "Lando could not start its provider runtime, so provider diagnostics were skipped. This is usually an unreadable `config.yml` or a conflicting installed plugin: check `lando config view` and `lando plugin list`.",
  command: "lando config view",
};

const interruptOnAbort = (signal: AbortSignal | undefined) =>
  Effect.async<never>((resume) => {
    if (signal === undefined) return;
    if (signal.aborted) {
      resume(Effect.interrupt);
      return;
    }
    const abort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

export const resilientDoctorReport = (
  options: DoctorOptions = {},
): Effect.Effect<DoctorReport, never, never> =>
  collectResilientDoctorReport(options).pipe((report) =>
    options.signal === undefined ? report : Effect.raceFirst(report, interruptOnAbort(options.signal)),
  );

const collectResilientDoctorReport = (options: DoctorOptions): Effect.Effect<DoctorReport, never, never> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sourceEnv = { ...(options.env ?? process.env) };
      const redactionService = yield* Effect.serviceOption(RedactionService);
      const redactor = Option.isSome(redactionService)
        ? yield* redactionService.value.forProfile("secrets", { sourceEnv })
        : createStandaloneRedactor("secrets", { sourceEnv });

      const runtime = makeLandoRuntime(
        cliRuntimeOptions({ bootstrap: "provider", plugins: { policy: "discovery" } }),
      );
      const built = yield* isolateDoctorSection({
        section: "provider-bootstrap",
        effect: Layer.build(runtime),
        fallback: undefined,
        redact: (value) => redactor.redactString(value),
        solutions: [BOOTSTRAP_REMEDIATION],
      });
      const context = built.value;

      // `ConfigServiceLive` is a pure `Layer.succeed`, so providing it here
      // cannot fail even when the full runtime could not be built.
      return yield* collectDoctorReport({
        options,
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
