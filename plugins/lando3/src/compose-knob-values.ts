import { ComposeServiceKnobKey, type ConfigTranslateDiagnostic, ServiceConfig } from "@lando/sdk/schema";
import { Result, Schema, SchemaIssue, Struct } from "effect";
import type { Lando3Path } from "./contract.ts";
import type { ServiceLoweringContext } from "./lowering-contract.ts";
import { unsupportedServiceKey } from "./service-diagnostics.ts";

const KNOB_FIELDS = new Set<string>(
  ComposeServiceKnobKey.literals.map((key) => (key.startsWith("deploy.") ? "deploy" : key)),
);
type KnobField = keyof typeof ServiceConfig.fields;
const isKnobField = (key: string): key is KnobField => KNOB_FIELDS.has(key);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Checks a Compose runtime knob value against the Lando 4 service schema, so a legacy value the
 * container engine cannot realize is reported at its source instead of failing the whole conversion.
 */
export const invalidKnobValue = (
  key: string,
  value: unknown,
  location: { readonly ctx: ServiceLoweringContext; readonly relative: Lando3Path },
): ConfigTranslateDiagnostic | undefined => {
  if (!isKnobField(key)) return undefined;
  const decoded = Schema.decodeUnknownResult(Schema.Struct(Struct.pick(ServiceConfig.fields, [key])))({
    [key]: value,
  });
  if (Result.isSuccess(decoded)) return undefined;
  const problems = formatIssues(decoded.failure.issue).issues.map(({ path, message }) => {
    const nested = (path ?? []).slice(1).join(".");
    return nested === "" ? message : `${nested}: ${message}`;
  });
  return unsupportedServiceKey({
    ...location,
    message: `Compose field ${key} has a value Lando 4 cannot realize (${[...new Set(problems)].join("; ")}).`,
    remediation: `Set ${key} to a value the container engine accepts, or remove it, before translating.`,
  });
};
