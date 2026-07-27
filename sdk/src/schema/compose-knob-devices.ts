import { ParseResult, Schema } from "effect";

const ExtensionFields = Schema.Record({
  key: Schema.TemplateLiteral("x-", Schema.String),
  value: Schema.Unknown,
});

export const ComposeDevice = Schema.extend(
  Schema.Struct({
    source: Schema.String,
    target: Schema.optional(Schema.String),
    permissions: Schema.optional(Schema.String),
  }),
  ExtensionFields,
);
export type ComposeDevice = typeof ComposeDevice.Type;

const deviceSegments = (input: string): ReadonlyArray<string> => {
  const segments = input.split(":");
  const drive = segments[0];
  const path = segments[1];
  if (drive === undefined || path === undefined || !/^[A-Za-z]$/.test(drive)) return segments;
  if (!path.startsWith("/") && !path.startsWith("\\")) return segments;
  return [`${drive}:${path}`, ...segments.slice(2)];
};

const ComposeDeviceEntryField = Schema.transformOrFail(
  Schema.Union(Schema.String, ComposeDevice),
  ComposeDevice,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (typeof input !== "string") return ParseResult.succeed(input);
      const segments = deviceSegments(input);
      if (segments.length !== 2 && segments.length !== 3) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            input,
            'Landofile service device must use "source:target" or "source:target:permissions".',
          ),
        );
      }
      const source = segments[0];
      const target = segments[1];
      const permissions = segments[2];
      if (source === undefined || source.length === 0 || target === undefined || target.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, input, "Landofile service device source and target must be non-empty."),
        );
      }
      if (permissions !== undefined && !/^[rwm]+$/.test(permissions)) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            input,
            "Landofile service device permissions may contain only r, w, and m.",
          ),
        );
      }
      return ParseResult.succeed({
        source,
        target,
        ...(permissions === undefined ? {} : { permissions }),
      });
    },
    encode: (input) => ParseResult.succeed(input),
  },
);

export const ComposeDevicesField = Schema.Array(ComposeDeviceEntryField).annotations({
  description:
    "Device mappings as source:target[:permissions] strings or long source, target, and permissions objects; canonicalized to a list of long objects.",
});
export type ComposeDevices = typeof ComposeDevicesField.Type;

const UlimitValue = Schema.Union(Schema.Int, Schema.String);

export const ComposeUlimit = Schema.extend(
  Schema.Struct({
    soft: UlimitValue,
    hard: UlimitValue,
  }),
  ExtensionFields,
);
export type ComposeUlimit = typeof ComposeUlimit.Type;

const ComposeUlimitEntryField = Schema.transformOrFail(
  Schema.Union(UlimitValue, ComposeUlimit),
  ComposeUlimit,
  {
    strict: true,
    decode: (input) => ParseResult.succeed(typeof input === "object" ? input : { soft: input, hard: input }),
    encode: (input) => ParseResult.succeed(input),
  },
);

const UlimitName = Schema.String.pipe(Schema.pattern(/^[a-z]+$/));

export const ComposeUlimitsField = Schema.Record({
  key: UlimitName,
  value: ComposeUlimitEntryField,
}).annotations({
  description:
    "Process limits as integer or string scalars, or explicit soft and hard objects; canonicalized to a map of soft and hard limit objects.",
});
export type ComposeUlimits = typeof ComposeUlimitsField.Type;
