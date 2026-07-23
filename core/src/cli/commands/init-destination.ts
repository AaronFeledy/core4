import { resolve } from "node:path";

export const resolveInitDestination = (input: {
  readonly cwd: string;
  readonly destination?: string;
  readonly name?: string;
}): string => resolve(input.cwd, input.destination ?? input.name ?? ".");
