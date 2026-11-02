import { compileServiceProbe } from "@lando/container-runtime/service-probe";
import { HealthcheckError, HealthcheckTargetUnsupportedError, ServiceExecError } from "@lando/sdk/errors";
import { type AppPlan, type HealthcheckPlan, type ServiceName, probeTargetError } from "@lando/sdk/schema";
import {
  type ProcessResult,
  ProcessRunner,
  type ProviderError,
  type RuntimeProviderShape,
  ShellRunner,
} from "@lando/sdk/services";
import { Effect } from "effect";
export { interruptOnAbort } from "@lando/container-runtime/healthcheck-attempt";

export interface HostProbeRunners {
  readonly shell?: Pick<ShellRunner["Service"], "run">;
  readonly process?: Pick<ProcessRunner["Service"], "run">;
}

export const captureHostProbeRunners = Effect.gen(function* () {
  const shell = yield* Effect.serviceOption(ShellRunner);
  const process = yield* Effect.serviceOption(ProcessRunner);
  return {
    ...(shell._tag === "Some" ? { shell: shell.value } : {}),
    ...(process._tag === "Some" ? { process: process.value } : {}),
  } satisfies HostProbeRunners;
});

export const unsupportedHealthcheckTarget = (
  service: ServiceName,
  probe: Pick<HealthcheckPlan, "executionTarget">,
) =>
  new HealthcheckTargetUnsupportedError({
    message: "The healthcheck execution target cannot honor this probe configuration.",
    service: String(service),
    target: probe.executionTarget ?? "service",
    remediation:
      "Use a service probe with an optional container user, or a host probe with its own command, no user or listener target, and host shell/process runners with an application plan.",
  });

export const validateProbeTarget = (probe: HealthcheckPlan, service: ServiceName) => {
  const error = probeTargetError(probe, service, "readiness");
  return error === undefined ? Effect.void : Effect.fail(error);
};

export const validateHealthcheckExecution = Effect.fnUntraced(function* (
  plan: AppPlan,
  runners: HostProbeRunners,
) {
  for (const service of Object.values(plan.services)) {
    for (const role of ["healthcheck", "readiness"] as const) {
      const probe = service[role];
      if (probe === undefined) continue;
      const invalid = probeTargetError(probe, service.name, role);
      if (invalid !== undefined) return yield* Effect.fail(invalid);
      if (probe.kind === "none") continue;
      if (
        probe.executionTarget === "host" &&
        (typeof probe.command === "string" ? runners.shell === undefined : runners.process === undefined)
      )
        return yield* Effect.fail(unsupportedHealthcheckTarget(service.name, probe));
    }
  }
});

export const prepareHealthcheckAttempt = Effect.fnUntraced(function* (input: {
  readonly probe: HealthcheckPlan;
  readonly app: AppPlan["id"];
  readonly service: ServiceName;
  readonly plan?: AppPlan;
  readonly exec: RuntimeProviderShape["exec"];
  readonly runners?: HostProbeRunners;
  readonly signal?: AbortSignal;
}): Effect.fn.Return<
  {
    readonly rendered: string;
    readonly run: Effect.Effect<ProcessResult, ProviderError>;
  },
  HealthcheckTargetUnsupportedError | HealthcheckError
> {
  const { probe, service, signal } = input;
  yield* validateProbeTarget(probe, service);
  const signalOption = signal === undefined ? {} : { signal };
  const hostFailure = () =>
    new ServiceExecError({
      providerId: input.plan?.provider ?? "host",
      operation: "readiness.host",
      service: String(service),
      message:
        "The host readiness process could not execute or capture its output (1 MiB per channel limit).",
      remediation:
        "Check the readiness executable and application directory, and keep private output below 1 MiB per channel, then retry.",
    });
  if (probe.executionTarget === "host") {
    const command = probe.command;
    const cwd = input.plan?.root;
    if (command === undefined || cwd === undefined)
      return yield* Effect.fail(unsupportedHealthcheckTarget(service, probe));
    if (typeof command === "string") {
      const shell = input.runners?.shell;
      if (shell === undefined) return yield* Effect.fail(unsupportedHealthcheckTarget(service, probe));
      return {
        rendered: command,
        run: Effect.suspend(() => shell.run(command, { cwd, capture: true, ...signalOption })).pipe(
          Effect.catchTag("ShellExecError", (error) =>
            error.exitCode === undefined
              ? Effect.fail(hostFailure())
              : Effect.succeed({ exitCode: error.exitCode, stdout: "", stderr: error.stderr ?? "" }),
          ),
        ),
      };
    }
    const process = input.runners?.process;
    const [cmd, ...args] = command;
    if (process === undefined || cmd === undefined)
      return yield* Effect.fail(unsupportedHealthcheckTarget(service, probe));
    return {
      rendered: command.join(" "),
      run: Effect.suspend(() => process.run({ cmd, args, cwd, capture: true, ...signalOption })).pipe(
        Effect.mapError(hostFailure),
      ),
    };
  }
  const compiled = yield* Effect.try({
    try: () => compileServiceProbe(probe, input.plan, input.plan?.services[service]),
    catch: () =>
      new HealthcheckError({
        service: String(service),
        message: "The service probe listener could not be resolved.",
        remediation: "Supply the full application plan and a declared service listener.",
      }),
  });
  if (compiled === undefined) return yield* Effect.fail(unsupportedHealthcheckTarget(service, probe));
  return {
    rendered: compiled.join(" "),
    run: Effect.suspend(() =>
      input.exec(
        {
          app: input.app,
          service,
          ...(input.plan === undefined ? {} : { plan: input.plan }),
          ...(probe.user === undefined ? {} : { user: probe.user }),
        },
        { command: [...compiled], raw: true, ...signalOption },
      ),
    ),
  };
});
