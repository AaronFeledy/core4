import { Schema } from "effect";
import { DeprecationNotice } from "./deprecation.ts";

// ==== Declarative command metadata, available without evaluating plugin code.

const token = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)*$/u));
const canonicalToken = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)+$/u));
const alias = Schema.Union([
  token,
  Schema.Struct({ name: token, deprecated: Schema.optionalKey(DeprecationNotice) }),
]);
const commandAlias = Schema.Union([
  canonicalToken,
  Schema.Struct({ name: canonicalToken, deprecated: Schema.optionalKey(DeprecationNotice) }),
]);

export const CommandContribution = Schema.Struct({
  id: canonicalToken
    .check(
      Schema.isPattern(/^(?!(?:plugin|global|scratch|meta:plugin|meta:global|apps:scratch)(?::|$))/u, {
        message:
          "Choose a plugin-owned namespace; plugin, global, scratch, meta:plugin, meta:global, and apps:scratch are reserved for Lando.",
      }),
    )
    .annotate({
      description: "Canonical colon-separated command id.",
    }),
  summary: Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(512)).annotate({
    description: "Nonblank bounded command summary, authoritative for help and listings.",
  }),
  hidden: Schema.optionalKey(Schema.Boolean).annotate({ description: "Omit this command from listings." }),
  aliases: Schema.optionalKey(Schema.Array(commandAlias).check(Schema.isUnique())).annotate({
    description: "Additional command tokens, subject to owner precedence.",
  }),
  topLevelAlias: Schema.optionalKey(Schema.Union([Schema.Boolean, alias, Schema.Array(alias)])).annotate({
    description: "Primary invocation alias; true strips the first namespace segment.",
  }),
  mcpAllowed: Schema.optionalKey(Schema.Boolean).annotate({ description: "Eligibility for MCP exposure." }),
  deprecated: Schema.optionalKey(DeprecationNotice).annotate({ description: "Command lifecycle notice." }),
}).annotate({ identifier: "CommandContribution", description: "Manifest-owned command descriptor." });
export type CommandContribution = typeof CommandContribution.Type;
