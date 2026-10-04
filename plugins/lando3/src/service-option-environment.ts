import { asStringArray, hasPlainObjectPrototype } from "./lowering-contract.ts";

export const hasAuthoredEnvironment = (environment: unknown, name: string): boolean =>
  hasPlainObjectPrototype(environment)
    ? Object.hasOwn(environment, name)
    : (asStringArray(environment) ?? []).some((assignment) => assignment.startsWith(`${name}=`));
