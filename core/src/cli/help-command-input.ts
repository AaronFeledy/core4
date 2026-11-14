import type { ExecutableCommandFlagSpec, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { argStdioDescription } from "./arg-stdio";
import type { OclifFlagDefinition } from "./compiled-argv";
import { UNIVERSAL_FORMAT_FLAG_NAMES } from "./format-flags";
import type { HelpCommandInput } from "./help-command-descriptor";
import type { FlagDefinition } from "./spec/metadata";

type HelpFlag = ExecutableCommandFlagSpec &
  Pick<FlagDefinition, "char" | "aliases"> & {
    readonly name?: string;
    readonly sensitive?: boolean;
  };

export const commandHelpInput = (
  spec: Pick<ExecutableCommandSpec, "args" | "strict"> & {
    readonly flags?: Readonly<Record<string, HelpFlag>>;
  },
  spellings?: Readonly<Record<string, OclifFlagDefinition>>,
): HelpCommandInput => ({
  flags: Object.entries(spec.flags ?? {})
    .filter(([name]) => !UNIVERSAL_FORMAT_FLAG_NAMES.has(name))
    .map(([name, flag]) => {
      const char = flag.char ?? spellings?.[name]?.char;
      const type = flag.type !== "boolean" && flag.valueType === "integer" ? "integer" : flag.type;
      return {
        name: flag.name ?? name,
        type: type === "option" ? "string" : type,
        required: flag.required === true,
        multiple: flag.multiple === true,
        ...(flag.description === undefined ? {} : { description: flag.description }),
        ...(flag.options === undefined ? {} : { options: flag.options }),
        ...(flag.default === undefined ? {} : { default: flag.default }),
        ...(char === undefined ? {} : { char }),
        ...(flag.aliases === undefined ? {} : { aliases: flag.aliases }),
        ...(flag.sensitive === undefined ? {} : { sensitive: flag.sensitive }),
      };
    }),
  args: Object.entries(spec.args ?? {}).map(([name, arg], _index, args) => {
    const description = argStdioDescription(arg);
    return {
      name,
      required: arg.required === true,
      multiple: arg.multiple === true || (spec.strict === false && args.length === 1),
      ...(description === undefined ? {} : { description }),
      ...(arg.options === undefined ? {} : { options: arg.options }),
      ...(arg.default === undefined ? {} : { default: arg.default }),
      ...(arg.stdio === undefined ? {} : { stdio: arg.stdio }),
    };
  }),
});
