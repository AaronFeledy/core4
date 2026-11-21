import { LandofileValidationError } from "@lando/sdk/errors";
import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";
import { Effect, Equal } from "effect";
import type { ExtraArgsLauncher } from "../services/feature.ts";
import type { PlannedServiceDraft } from "./service-types.ts";

const replaceProcess = "Put the flags in command: instead, or remove the process override to use extraArgs.";

interface ExtraArgsLocation {
  readonly name: string;
  readonly file: string;
}

type ProcessCommand = Pick<ServicePlan, "command" | "entrypoint">;

const errorAt = (
  location: ExtraArgsLocation,
  issue: { readonly message: string; readonly remediation: string; readonly index?: number },
) =>
  new LandofileValidationError({
    file: location.file,
    message: issue.message,
    remediation: issue.remediation,
    issues: [
      {
        path: ["services", location.name, "extraArgs", ...(issue.index === undefined ? [] : [issue.index])],
        message: issue.message,
        suggestion: issue.remediation,
      },
    ],
  });

export const authoredExtraArgsConflict = (location: ExtraArgsLocation, config: ServiceConfig) =>
  (config.extraArgs?.length ?? 0) > 0 && (config.command !== undefined || config.entrypoint !== undefined)
    ? errorAt(location, {
        message: "extraArgs cannot be combined with an authored command: or entrypoint:.",
        remediation: replaceProcess,
      })
    : undefined;

const verifyExtraArgs = (input: {
  readonly location: ExtraArgsLocation;
  readonly expected: ProcessCommand;
  readonly actual: ProcessCommand;
}) => {
  if (
    Equal.equals(input.expected.command, input.actual.command) &&
    Equal.equals(input.expected.entrypoint, input.actual.entrypoint)
  )
    return Effect.void;
  return Effect.fail(
    errorAt(input.location, {
      message: "A feature replaced the launcher that accepts extraArgs.",
      remediation: replaceProcess,
    }),
  );
};

export const verifyComposedExtraArgs = Effect.fnUntraced(function* (
  drafts: readonly PlannedServiceDraft[],
  services: Readonly<Record<string, ServicePlan>>,
  file: string,
) {
  for (const { name, extraArgsProcess } of drafts) {
    if (extraArgsProcess !== undefined) {
      yield* verifyExtraArgs({
        location: { name, file },
        expected: extraArgsProcess,
        actual: services[name] ?? {},
      });
    }
  }
});

export const appendExtraArgs = Effect.fnUntraced(function* (input: {
  readonly location: ExtraArgsLocation;
  readonly config: ServiceConfig;
  readonly type: ServiceType;
  readonly process: ProcessCommand;
  readonly launcher: ExtraArgsLauncher | undefined;
}) {
  const { location, config, type, process, launcher } = input;
  const args = config.extraArgs;
  if (args === undefined || args.length === 0) return undefined;
  if (launcher === undefined) {
    const advice = type.extraArgsRemediation;
    return yield* errorAt(location, {
      message: `Service type ${type.id} has no launcher that accepts extraArgs in this configuration.`,
      remediation:
        (typeof advice === "function" ? advice(config) : advice) ??
        "Use command: to specify the entire launcher, or remove extraArgs.",
    });
  }
  yield* verifyExtraArgs({ location, expected: launcher, actual: process });
  const reserved = launcher.extraArgs(args);
  if (reserved !== undefined)
    return yield* errorAt(location, {
      ...reserved,
      message: "This extraArgs option is reserved by the service launcher.",
    });
  return {
    command: [...launcher.command, ...args],
    ...(launcher.entrypoint === undefined ? {} : { entrypoint: launcher.entrypoint }),
  };
});
