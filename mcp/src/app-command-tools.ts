import { McpToolInputError } from "@lando/sdk/errors";
import { type McpToolDescriptor, getJsonSchemaWithDeprecations } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

export const APP_COMMAND_LIST_ID = "app:commands:list";
export const APP_COMMAND_CALL_ID = "app:commands:call";
export const APP_COMMAND_TOOL_IDS = [APP_COMMAND_LIST_ID, APP_COMMAND_CALL_ID] as const;

const AppCommandListInput = Schema.Struct({ appPath: Schema.String });
const AppCommandCallInput = Schema.Struct({
  appPath: Schema.String,
  commandId: Schema.String,
  flags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

export const APP_COMMAND_INPUT_SCHEMAS = {
  [APP_COMMAND_LIST_ID]: getJsonSchemaWithDeprecations(AppCommandListInput),
  [APP_COMMAND_CALL_ID]: getJsonSchemaWithDeprecations(AppCommandCallInput),
} as const;

const decodeError = (id: string) =>
  new McpToolInputError({
    message: `Invalid input for tool ${id}.`,
    toolId: id,
    remediation: "Provide the declared appPath, commandId, flags, and args fields with their expected types.",
  });

export const decodeAppCommandListInput = (input: unknown) =>
  Schema.decodeUnknownEffect(AppCommandListInput)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => decodeError(APP_COMMAND_LIST_ID)),
  );

export const decodeAppCommandCallInput = (input: unknown) =>
  Schema.decodeUnknownEffect(AppCommandCallInput)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => decodeError(APP_COMMAND_CALL_ID)),
  );

export const APP_COMMAND_DESCRIPTORS: ReadonlyArray<McpToolDescriptor> = [
  {
    toolId: APP_COMMAND_LIST_ID,
    commandId: APP_COMMAND_LIST_ID,
    title: "List app plugin commands",
    description: "List MCP-allowed plugin commands for the selected app.",
    destructive: false,
    inputSchema: APP_COMMAND_INPUT_SCHEMAS[APP_COMMAND_LIST_ID],
  },
  {
    toolId: APP_COMMAND_CALL_ID,
    commandId: APP_COMMAND_CALL_ID,
    title: "Call app plugin command",
    description: "Call an MCP-allowed plugin command in the selected app.",
    destructive: true,
    inputSchema: APP_COMMAND_INPUT_SCHEMAS[APP_COMMAND_CALL_ID],
  },
];
