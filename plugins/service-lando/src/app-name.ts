import { basename } from "node:path";

export const appNameFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => input.appName || basename(input.appRoot) || "app";

/** Stable input for values stored inside data volumes; runtime identity still uses appNameFor. */
export const dataNameFor = (input: {
  readonly dataName?: string | undefined;
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => input.dataName ?? appNameFor(input);
