import { listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { expectedTcpListener, observeTcpListener } from "@lando/container-runtime/listener-observation";
import { resolveAppliedStateTarget } from "@lando/engine/operations/applied-state-target";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import type { DoctorFinding, DoctorSectionResult } from "./doctor-contract";
import { isolateDoctorSection } from "./doctor-self";

const skipped = (check: string | undefined, reason: string): DoctorSectionResult => ({
  checks: [],
  skipped: [{ ...(check === undefined ? {} : { check }), reason }],
});

const collectListeners = Effect.fnUntraced(function* (
  redact: (value: string) => string,
): Effect.fn.Return<
  DoctorSectionResult,
  Effect.Error<typeof resolveAppliedStateTarget>,
  RuntimeProviderRegistry | Effect.Services<typeof resolveAppliedStateTarget>
> {
  const target = yield* resolveAppliedStateTarget;
  if (target === undefined)
    return skipped(undefined, "No applied plan was found for the current app; no listeners were observed.");
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(target.plan);
  if ((yield* provider.getStatus).state === "idle")
    return skipped(
      undefined,
      `Provider ${provider.id} holding the applied app is idle; no listeners were inspected.`,
    );
  const running = yield* provider.list({ app: target.plan.id });
  const results = yield* Effect.forEach(
    Object.values(target.plan.services),
    (service): Effect.Effect<DoctorSectionResult> => {
      const checkName = `app-listener:${service.name}`;
      const expected = expectedTcpListener(service);
      if (expected === undefined)
        return Effect.succeed(
          skipped(checkName, "No expected TCP listener is recorded in the applied plan."),
        );
      const observed = running.find((entry) => entry.service === service.name);
      if (observed === undefined || observed.status !== "running")
        return Effect.succeed(
          skipped(checkName, "The service is not running; no listener observation was attempted."),
        );
      return observeTcpListener(service, (command) =>
        provider.execStream({ app: target.plan.id, service: service.name, plan: target.plan }, command),
      ).pipe(
        Effect.map((listener): DoctorSectionResult => {
          if (listener === undefined)
            return skipped(
              checkName,
              "TCP listener observation is unavailable; this is not evidence of an absent listener.",
            );
          const diagnostic: {
            readonly finding: string;
            readonly action: string;
            readonly authority?: string;
          } = listenerDiagnostic(listener, service);
          const status = listener.state === "listening" ? "pass" : "warn";
          let finding: string;
          switch (listener.state) {
            case "listening":
              finding = `TCP ${listener.port} has a non-loopback binding; this does not prove application readiness.`;
              break;
            case "not-listening":
              finding = `No TCP listener was observed on planned port ${listener.port} at this instant. If the application is still starting, rerun \`lando doctor --app\`.`;
              break;
            case "loopback-only":
              finding = diagnostic.finding;
              break;
            default: {
              const unreachable: never = listener.state;
              return unreachable;
            }
          }
          const check: DoctorFinding = {
            name: "app-listener",
            status,
            severity: status === "pass" ? "info" : "warn",
            context: {
              providerId: provider.id,
              app: String(target.plan.id),
              service: String(service.name),
              port: String(listener.port),
              listenerState: listener.state,
              finding: redact(finding),
              bindings: listener.listening.map((binding) => `${binding.address}:${binding.port}`).join(", "),
            },
            solutions:
              status === "pass"
                ? []
                : [
                    {
                      kind: "manual",
                      description: redact(
                        diagnostic.action + (diagnostic.authority ? ` ${diagnostic.authority}` : ""),
                      ),
                    },
                  ],
          };
          return { checks: [check] };
        }),
      );
    },
    { concurrency: 4 },
  );
  return {
    checks: results.flatMap((result) => result.checks),
    skipped: results.flatMap((result) => result.skipped ?? []),
  };
});

export const listenerDoctorChecks = Effect.fnUntraced(function* (input: {
  readonly budgetMs: number;
  readonly redact: (value: string) => string;
}) {
  const outcome = yield* isolateDoctorSection({
    section: "app-listeners",
    effect: collectListeners(input.redact),
    fallback: skipped(
      undefined,
      "Applied listener inspection could not complete within its budget or was unavailable; no listener verdict was made.",
    ),
    budgetMs: input.budgetMs,
    redact: input.redact,
  });
  return outcome.self === undefined
    ? outcome.value
    : skipped(undefined, `${outcome.self.context.reason}: ${outcome.self.context.message}`);
});
