import type { NormalizedToolingArg, NormalizedToolingFlag, ToolingInputDeclaration } from "@lando/sdk/schema";
import type { JsonSchemaObject } from "./registry";

const group = (members: readonly (NormalizedToolingFlag | NormalizedToolingArg)[]): JsonSchemaObject => {
  const required = members.filter((member) => member.required).map((member) => member.name);
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      members.map((member) => [
        member.name,
        {
          type: "boolean" in member && member.boolean ? "boolean" : "string",
          ...(member.description === undefined ? {} : { description: member.description }),
          ...(member.choices === undefined ? {} : { enum: [...member.choices] }),
          ...(member.default === undefined ? {} : { default: member.default }),
          ...(member.sensitive ? { writeOnly: true } : {}),
        },
      ]),
    ),
    ...(required.length === 0 ? {} : { required }),
  };
};

export const toolingInputSchema = (input: ToolingInputDeclaration): JsonSchemaObject => {
  const raw = input.flags.length + input.args.length === 0 && input.acceptsArguments;
  const required = (["flags", "args"] as const).filter((key) => input[key].some((member) => member.required));
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      flags: group(input.flags),
      args: raw
        ? {
            type: "object",
            properties: { args: { type: "array", items: { type: "string" } } },
            additionalProperties: false,
          }
        : group(input.args),
    },
    ...(required.length === 0 ? {} : { required }),
    "x-lando-input-revision": input.revision,
    "x-lando-accepts-arguments": input.acceptsArguments,
  };
};
