import type { ExecutableCommandFlagSpec, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { argStdioDescription } from "./arg-stdio";
import type { OclifFlagDefinition } from "./compiled-argv";
import type { HelpCommandInput } from "./help-command-descriptor";
import type { FlagDefinition } from "./spec/metadata";

const universalFlags = new Set([
  "format",
  "json",
  "jq",
  "renderer",
  "verbose",
  "log-level",
  "debug",
  "trace",
]);

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
    .filter(([name]) => !universalFlags.has(name))
    .map(([name, flag]) => {
      const char = flag.char ?? spellings?.[name]?.char;
      return {
        name: flag.name ?? name,
        type:
          flag.type === "boolean"
            ? "boolean"
            : flag.valueType === "integer"
              ? "integer"
              : flag.type === "number"
                ? "number"
                : "string",
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
      ...(arg.stdio === undefined ? {} : { stdio: arg.stdio }),
    };
  }),
});
