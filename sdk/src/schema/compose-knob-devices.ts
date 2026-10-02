import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

const ExtensionFields = Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown);

export const ComposeDevice = Schema.Struct({
    source: Schema.String,
    target: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(Schema.String),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeDevice = typeof ComposeDevice.Type;

const deviceSegments = (input: string): ReadonlyArray<string> => {
  const segments = input.split(":");
  const drive = segments[0];
  const path = segments[1];
  if (drive === undefined || path === undefined || !/^[A-Za-z]$/.test(drive)) return segments;
  if (!path.startsWith("/") && !path.startsWith("\\")) return segments;
  return [`${drive}:${path}`, ...segments.slice(2)];
};

const ComposeDeviceEntryField = Schema.Union([Schema.String, ComposeDevice]).pipe(Schema.decodeTo(ComposeDevice, SchemaTransformation.transformEffect({ decode: (input, _options) => { 
      if (typeof input !== "string") return Effect.succeed(input);
      const segments = deviceSegments(input);
      if (segments.length !== 2 && segments.length !== 3) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: 'Landofile service device must use "source:target" or "source:target:permissions".' }, input),
        );
      }
      const source = segments[0];
      const target = segments[1];
      const permissions = segments[2];
      if (source === undefined || source.length === 0 || target === undefined || target.length === 0) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: "Landofile service device source and target must be non-empty." }, input),
        );
      }
      if (permissions !== undefined && !/^[rwm]+$/.test(permissions)) {
        return Effect.fail(
          new SchemaIssue.InvalidValue({ message: "Landofile service device permissions may contain only r, w, and m." }, input),
        );
      }
      return Effect.succeed({
        source,
        target,
        ...(permissions === undefined ? {} : { permissions }),
      });
     }, encode: (input) => Effect.succeed(input) })));

export const ComposeDevicesField = Schema.Array(ComposeDeviceEntryField).annotate({
  description:
    "Device mappings as source:target[:permissions] strings or long source, target, and permissions objects; canonicalized to a list of long objects.",
});
export type ComposeDevices = typeof ComposeDevicesField.Type;

const UlimitValue = Schema.Union([Schema.Int, Schema.String]);

export const ComposeUlimit = Schema.Struct({
    soft: UlimitValue,
    hard: UlimitValue,
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeUlimit = typeof ComposeUlimit.Type;

const ComposeUlimitEntryField = Schema.Union([UlimitValue, ComposeUlimit]).pipe(Schema.decodeTo(ComposeUlimit, SchemaTransformation.transformEffect({ decode: (input) => Effect.succeed(typeof input === "object" ? input : { soft: input, hard: input }), encode: (input) => Effect.succeed(input) })));

const UlimitName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]+$/)));

export const ComposeUlimitsField = Schema.Record(UlimitName, ComposeUlimitEntryField).annotate({
  description:
    "Process limits as integer or string scalars, or explicit soft and hard objects; canonicalized to a map of soft and hard limit objects.",
});
export type ComposeUlimits = typeof ComposeUlimitsField.Type;
