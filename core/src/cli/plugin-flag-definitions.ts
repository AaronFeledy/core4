import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import type { OclifFlagDefinition } from "./compiled-argv";
import { universalFormatFlagDefs } from "./format-flags";
import { yesFlag } from "./spec/confirmation-flag";

// Code generators import this before the command registry and its generated
// tables exist, so it must stay free of runtime imports from the argv parser.
export const pluginFlagDefinitions = (
  spec: Pick<ExecutableCommandSpec, "flags">,
): Readonly<Record<string, OclifFlagDefinition>> => {
  const flags: Record<string, OclifFlagDefinition> = { ...universalFormatFlagDefs };
  for (const [name, definition] of Object.entries(spec.flags ?? {})) {
    if (name === "yes") {
      flags[name] = yesFlag(definition.description);
      continue;
    }
    flags[name] = {
      name,
      type: definition.type === "boolean" ? "boolean" : "option",
      ...(definition.valueType === undefined ? {} : { valueType: definition.valueType }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(definition.multiple === undefined ? {} : { multiple: definition.multiple }),
      ...(definition.options === undefined ? {} : { options: definition.options }),
    };
  }
  return flags;
};
