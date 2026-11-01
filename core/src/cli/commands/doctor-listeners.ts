import { listenerDiagnostic } from "@lando/container-runtime/listener-diagnostic";
import { expectedTcpListener, observeTcpListener } from "@lando/container-runtime/listener-observation";
import { resolveAppliedStateTarget } from "@lando/engine/operations/applied-state-target";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { type DoctorCheck, type DoctorResult, providerKindFor } from "./doctor-contract";
import { isolateDoctorSection } from "./doctor-self";

const skipped = (section: string, reason: string): DoctorResult => ({
  checks: [],
  skipped: [{ section, status: "skipped", reason }],
});

const collectListeners = Effect.fnUntraced(function* (): Effect.fn.Return<
  DoctorResult,
  Effect.Error<typeof resolveAppliedStateTarget>,
  RuntimeProviderRegistry | Effect.Services<typeof resolveAppliedStateTarget>
> {
  const target = yield* resolveAppliedStateTarget;
  if (target === undefined)
    return skipped(
      "app-listeners",
      "No applied plan was found for the current app; no listeners were observed.",
    );
  const registry = yield* RuntimeProviderRegistry;
  const provider = yield* registry.select(target.plan);
  const running = yield* provider.list({ app: target.plan.id });
  const results = yield* Effect.forEach(
    Object.values(target.plan.services),
    (service): Effect.Effect<DoctorResult> => {
      const section = `app-listener:${service.name}`;
      const expected = expectedTcpListener(service);
      if (expected === undefined)
        return Effect.succeed(skipped(section, "No expected TCP listener is recorded in the applied plan."));
      const observed = running.find((entry) => entry.service === service.name);
      if (observed === undefined || (observed.state ?? observed.status) !== "running")
        return Effect.succeed(
          skipped(section, "The service is not running; no listener observation was attempted."),
        );
      return observeTcpListener(service, (command) =>
        provider.execStream({ app: target.plan.id, service: service.name, plan: target.plan }, command),
      ).pipe(
        Effect.map((listener): DoctorResult => {
          if (listener === undefined)
            return skipped(
              section,
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
          const check: DoctorCheck = {
            name: "app-listener",
            status,
            severity: status === "pass" ? "info" : "warn",
            providerId: provider.id,
            providerName: provider.displayName,
            providerVersion: provider.version,
            providerKind: providerKindFor(provider.id),
            runtimeStatus: "running",
            runtime: { running: true },
            capabilities: {},
            context: {
              app: String(target.plan.id),
              service: String(service.name),
              port: String(listener.port),
              listenerState: listener.state,
              finding,
              bindings: listener.listening.map((binding) => `${binding.address}:${binding.port}`).join(", "),
            },
            solutions:
              status === "pass"
                ? []
                : [
                    {
                      kind: "manual",
                      description:
                        diagnostic.action + (diagnostic.authority ? ` ${diagnostic.authority}` : ""),
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
    effect: collectListeners(),
    fallback: skipped(
      "app-listeners",
      "Applied listener inspection could not complete within its budget or was unavailable; no listener verdict was made.",
    ),
    budgetMs: input.budgetMs,
    redact: input.redact,
  });
  return outcome.self === undefined
    ? outcome.value
    : skipped("app-listeners", `${outcome.self.reason}: ${outcome.self.context.message}`);
});
