import { specArgsOf, specFlagsOf } from "../../../spec/input-coercion";

export const globalPolicyOptionsFromInput = (input: unknown) => {
  const raw = specArgsOf(input).selector;
  const selectors = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : typeof raw === "string"
      ? [raw]
      : [];
  const flags = specFlagsOf(input);
  return { selectors, all: flags.all === true, dryRun: flags["dry-run"] === true };
};
