import { Effect, Schema, SchemaTransformation } from "effect";
import { ComposeScalarMap, ComposeScalarMapField } from "./compose-knob-maps.ts";
import { ComposeByteSizeField, integerTextCheck } from "./compose-knob-scalars.ts";
import { layerMerge } from "./layer-merge.ts";

const ExtensionFields = Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown);
const ScalarOption = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

export const ComposeLogging = Schema.Struct({
  driver: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Record(Schema.String, ScalarOption)),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeLogging = typeof ComposeLogging.Type;

// ============================================================================
// Device counts - "all" or an integer number of devices
// ============================================================================

const DEVICE_COUNT_PATTERN = /^(?:[Aa][Ll][Ll]|[+-]?[0-9]+)$/;
const DeviceCount = Schema.Union([
  Schema.Int,
  Schema.String.check(
    Schema.makeFilter(
      (text: string) =>
        text.toLowerCase() === "all" ||
        (DEVICE_COUNT_PATTERN.test(text) && Number.isSafeInteger(Number(text))),
      {
        expected: 'a device count of "all" or an integer',
        // The safe-integer bound has no JSON Schema form; the pattern alone is the looser editor rule.
        toJsonSchema: () => [{ pattern: DEVICE_COUNT_PATTERN.source }, true],
      },
    ),
  ),
]);

export const ComposeGpuRequest = Schema.Struct({
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  count: Schema.optionalKey(DeviceCount),
  device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  driver: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(ComposeScalarMapField),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeGpuRequest = typeof ComposeGpuRequest.Type;

export const ComposeGpusField = Schema.Union([
  Schema.Literal("all"),
  layerMerge(Schema.Array(ComposeGpuRequest), { kind: "replace" }),
]).annotate({
  description:
    'GPU access as the Compose literal "all" or a device-request list; canonical output preserves "all" or uses device objects with options canonicalized to maps.',
});
export type ComposeGpus = typeof ComposeGpusField.Type;

// ============================================================================
// Resource limits - values a container engine can represent
// ============================================================================

// Engines take whole nanoCPUs as a safe integer, which caps the CPU count.
const MAX_CPUS = Math.floor(Number.MAX_SAFE_INTEGER / 1e9);
const CPUS_EXPECTED = `a non-negative CPU count no larger than ${MAX_CPUS}, such as 0.5 or 2`;
const DECIMAL_TEXT_PATTERN = /^\+?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;

const ResourceCpu = Schema.Union([
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: MAX_CPUS }, { expected: CPUS_EXPECTED })),
  Schema.String.check(
    Schema.makeFilter((text: string) => DECIMAL_TEXT_PATTERN.test(text) && Number(text) <= MAX_CPUS, {
      expected: CPUS_EXPECTED,
      // The upper bound has no JSON Schema form on text; the pattern alone is the looser editor rule.
      toJsonSchema: () => [{ pattern: DECIMAL_TEXT_PATTERN.source }, true],
    }),
  ),
]);
const ResourcePids = Schema.Union([
  Schema.Int,
  Schema.String.check(integerTextCheck("an integer process limit such as 100")),
]);
const ResourceMemory = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0, { expected: "a non-negative byte size; 0 means no limit" }),
);

export const ComposeResourceLimits = Schema.Struct({
  cpus: Schema.optionalKey(ResourceCpu),
  memory: Schema.optionalKey(ResourceMemory),
  pids: Schema.optionalKey(ResourcePids),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeResourceLimits = typeof ComposeResourceLimits.Type;

const ComposeResourceLimitsInput = Schema.Struct({
  cpus: Schema.optionalKey(ResourceCpu),
  memory: Schema.optionalKey(ComposeByteSizeField),
  pids: Schema.optionalKey(ResourcePids),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));

export const ComposeDeploymentDevice = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  count: Schema.optionalKey(DeviceCount),
  device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  driver: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(ComposeScalarMap),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeDeploymentDevice = typeof ComposeDeploymentDevice.Type;

const ComposeDeploymentDeviceInput = Schema.Struct({
  capabilities: Schema.Array(Schema.String),
  count: Schema.optionalKey(DeviceCount),
  device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
  driver: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(ComposeScalarMapField),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));

// Compose applies reservations.cpus and reservations.generic_resources only under Swarm, so the
// Landofile rejects them and they are not part of the schema.
export const ComposeResourceReservations = Schema.Struct({
  memory: Schema.optionalKey(ResourceMemory),
  devices: Schema.optionalKey(layerMerge(Schema.Array(ComposeDeploymentDevice), { kind: "replace" })),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeResourceReservations = typeof ComposeResourceReservations.Type;

const ComposeResourceReservationsInput = Schema.Struct({
  memory: Schema.optionalKey(ComposeByteSizeField),
  devices: Schema.optionalKey(layerMerge(Schema.Array(ComposeDeploymentDeviceInput), { kind: "replace" })),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));

export const ComposeDeployResources = Schema.Struct({
  limits: Schema.optionalKey(ComposeResourceLimits),
  reservations: Schema.optionalKey(ComposeResourceReservations),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeDeployResources = typeof ComposeDeployResources.Type;

const ComposeDeployResourcesInput = Schema.Struct({
  limits: Schema.optionalKey(ComposeResourceLimitsInput),
  reservations: Schema.optionalKey(ComposeResourceReservationsInput),
}).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));

export const ComposeDeploy = Schema.Struct({
  resources: Schema.optionalKey(ComposeDeployResources),
});
export type ComposeDeploy = typeof ComposeDeploy.Type;

const ComposeDeployInput = Schema.Struct({
  resources: Schema.optionalKey(ComposeDeployResourcesInput),
});

const ComposeDeployObjectField = ComposeDeployInput.pipe(
  Schema.decodeTo(
    Schema.UndefinedOr(ComposeDeploy),
    SchemaTransformation.transformEffect({
      decode: (input) => Effect.succeed(input.resources === undefined ? {} : { resources: input.resources }),
      encode: (input: typeof ComposeDeploy.Encoded | undefined) => Effect.succeed(input ?? {}),
    }),
  ),
);

export const ComposeDeployField = Schema.Union([ComposeDeployObjectField, Schema.Null]).annotate({
  description:
    "Deployment resources as null or a limits and reservations object; canonicalized to resources-only data with memory in bytes and device options as maps.",
});
