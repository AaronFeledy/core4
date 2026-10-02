import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

import { ComposeScalarMap, ComposeScalarMapField } from "./compose-knob-maps.ts";
import { ComposeByteSizeField } from "./compose-knob-scalars.ts";

const ExtensionFields = Schema.Record(Schema.TemplateLiteral(["x-", Schema.String]), Schema.Unknown);
const ScalarOption = Schema.Union([Schema.String, Schema.Number, Schema.Null]);

export const ComposeLogging = Schema.Struct({
    driver: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Record(Schema.String, ScalarOption)),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeLogging = typeof ComposeLogging.Type;

export const ComposeGpuRequest = Schema.Struct({
    capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
    count: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
    device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
    driver: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(ComposeScalarMapField),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeGpuRequest = typeof ComposeGpuRequest.Type;

export const ComposeGpusField = Schema.Union([Schema.Literal("all"), Schema.Array(ComposeGpuRequest)]).annotate({
  description:
    'GPU access as the Compose literal "all" or a device-request list; canonical output preserves "all" or uses device objects with options canonicalized to maps.',
});
export type ComposeGpus = typeof ComposeGpusField.Type;

const ResourceCpu = Schema.Union([Schema.Number, Schema.String]);
const ResourcePids = Schema.Union([Schema.Int, Schema.String]);

export const ComposeResourceLimits = Schema.Struct({
    cpus: Schema.optionalKey(ResourceCpu),
    memory: Schema.optionalKey(Schema.Int),
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
    count: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
    device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
    driver: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(ComposeScalarMap),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeDeploymentDevice = typeof ComposeDeploymentDevice.Type;

const ComposeDeploymentDeviceInput = Schema.Struct({
    capabilities: Schema.Array(Schema.String),
    count: Schema.optionalKey(Schema.Union([Schema.String, Schema.Int])),
    device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
    driver: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(ComposeScalarMapField),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));

export const ComposeDiscreteResourceSpec = Schema.Struct({
    kind: Schema.optionalKey(Schema.String),
    value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeDiscreteResourceSpec = typeof ComposeDiscreteResourceSpec.Type;

export const ComposeGenericResource = Schema.Struct({
    discrete_resource_spec: Schema.optionalKey(ComposeDiscreteResourceSpec),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeGenericResource = typeof ComposeGenericResource.Type;

export const ComposeResourceReservations = Schema.Struct({
    cpus: Schema.optionalKey(ResourceCpu),
    memory: Schema.optionalKey(Schema.Int),
    devices: Schema.optionalKey(Schema.Array(ComposeDeploymentDevice)),
    generic_resources: Schema.optionalKey(Schema.Array(ComposeGenericResource)),
  }).pipe((self) => Schema.StructWithRest(self, [ExtensionFields]));
export type ComposeResourceReservations = typeof ComposeResourceReservations.Type;

const ComposeResourceReservationsInput = Schema.Struct({
    cpus: Schema.optionalKey(ResourceCpu),
    memory: Schema.optionalKey(ComposeByteSizeField),
    devices: Schema.optionalKey(Schema.Array(ComposeDeploymentDeviceInput)),
    generic_resources: Schema.optionalKey(Schema.Array(ComposeGenericResource)),
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

const ComposeDeployObjectField = ComposeDeployInput.pipe(Schema.decodeTo(Schema.UndefinedOr(ComposeDeploy), SchemaTransformation.transformEffect({ decode: (input) =>
      Effect.succeed(input.resources === undefined ? {} : { resources: input.resources }), encode: (input: typeof ComposeDeploy.Encoded | undefined) => Effect.succeed(input ?? {}) })));

export const ComposeDeployField = Schema.Union([ComposeDeployObjectField, Schema.Null]).annotate({
  description:
    "Deployment resources as null or a limits and reservations object; canonicalized to resources-only data with memory in bytes and device options as maps.",
});
