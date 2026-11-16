import type { BuildAppKind } from "./build-app-kind.ts";

/** Join remediation sentences without a trailing or doubled space. */
export const buildFailureRemediation = (base: string, suffix: string): string =>
  [base.trimEnd(), suffix.trimStart()].filter((part) => part.length > 0).join(" ");

const assertNever = (value: never): never => value;

/**
 * Where a failed build's output lives, and how to read it. A scratch app's output is removed with
 * the app after a failed start, so naming its path would point at a file the cleanup deletes.
 */
export const buildRemediationSuffix = (
  kind: BuildAppKind,
  serviceName: string,
  transcriptPath: string | undefined,
): string => {
  switch (kind) {
    case "user":
      return transcriptPath === undefined
        ? `Run "lando logs --build --service ${serviceName}" to print it.`
        : `The full build output for service ${serviceName} is in ${transcriptPath}. Run "lando logs --build --service ${serviceName}" to print it.`;
    case "global":
      return transcriptPath === undefined
        ? ""
        : `The full build output for service ${serviceName} is in ${transcriptPath}.`;
    case "scratch":
      return "The scratch app and its build output are removed after a failed start unless it is kept; keep it with lando scratch:start --keep-on-failure.";
    default:
      return assertNever(kind);
  }
};
