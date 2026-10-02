import { basename } from "node:path";

export const appNameFor = (input: {
  readonly appName?: string | undefined;
  readonly appRoot: string;
}): string => input.appName || basename(input.appRoot) || "app";
