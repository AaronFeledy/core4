import { asStringArray, isPlainObject } from "./lowering-contract.ts";

export const hasAuthoredEnvironment = (environment: unknown, name: string): boolean =>
  isPlainObject(environment)
    ? Object.hasOwn(environment, name)
    : (asStringArray(environment) ?? []).some((assignment) => assignment.startsWith(`${name}=`));
