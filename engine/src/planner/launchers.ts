import type { ValidationIssue } from "@lando/sdk/schema";
import { ServiceLauncherMarker, ServiceLaunchers } from "@lando/sdk/services";
import { Result, Schema } from "effect";

export const LauncherServiceFacts = Schema.Record(
  Schema.String,
  Schema.Struct({ serviceTypeId: Schema.String, launchers: Schema.optionalKey(ServiceLaunchers) }),
);
export type LauncherServiceFacts = typeof LauncherServiceFacts.Type;

export const isLauncherMarker = Schema.is(ServiceLauncherMarker);

export const launcherPrefix = (head: string | undefined, launchers: ServiceLaunchers | undefined) =>
  head !== undefined && launchers !== undefined && Object.hasOwn(launchers, head)
    ? launchers[head]
    : undefined;

const launcherFailures = {
  "launcher-missing-command": "requires a command",
  "launcher-chained-marker": "cannot be followed by another launcher marker",
  "launcher-unavailable-target": "is not declared",
  "launcher-undeclared-marker": "is not declared",
} as const;

type LauncherIssue = ValidationIssue & {
  readonly reason: keyof typeof launcherFailures;
  readonly suggestion: string;
};

export const lowerLauncher = (
  argv: readonly string[],
  target: { readonly name: string | undefined; readonly facts: LauncherServiceFacts[string] | undefined },
): Result.Result<readonly string[], LauncherIssue> => {
  const [marker, command, ...args] = argv;
  if (marker === undefined || !isLauncherMarker(marker)) return Result.succeed(argv);
  const prefix = launcherPrefix(marker, target.facts?.launchers);
  if (command !== undefined && command !== "" && !isLauncherMarker(command) && prefix !== undefined)
    return Result.succeed([...prefix, command, ...args]);
  const { name, facts } = target;
  const label =
    name === ":host"
      ? "the host"
      : name === undefined
        ? "no primary service"
        : `service ${name}${facts === undefined ? "" : ` (${facts.serviceTypeId})`}`;
  const declared = Object.keys(facts?.launchers ?? {}).sort();
  const reason =
    command === undefined || command === ""
      ? "launcher-missing-command"
      : isLauncherMarker(command)
        ? "launcher-chained-marker"
        : declared.length === 0
          ? "launcher-unavailable-target"
          : "launcher-undeclared-marker";
  return Result.fail({
    path: [],
    reason,
    message: `Launcher ${marker} ${launcherFailures[reason]} for ${label}. Declared launchers: ${declared.join(", ") || "none"}.`,
    suggestion:
      "Use a launcher declared by the target service followed by a command, or use a literal executable (./:name for a colon-prefixed filename).",
  });
};
