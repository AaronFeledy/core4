import { ParseResult, Schema } from "effect";

import { ComposeScalarMap, ComposeScalarMapField } from "./compose-knob-maps.ts";
import { ComposeByteSizeField } from "./compose-knob-scalars.ts";

const ExtensionFields = Schema.Record({
  key: Schema.TemplateLiteral("x-", Schema.String),
  value: Schema.Unknown,
});
const ScalarOption = Schema.Union(Schema.String, Schema.Number, Schema.Null);

export const ComposeLogging = Schema.extend(
  Schema.Struct({
    driver: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Record({ key: Schema.String, value: ScalarOption })),
  }),
  ExtensionFields,
);
export type ComposeLogging = typeof ComposeLogging.Type;

export const ComposeGpuRequest = Schema.extend(
  Schema.Struct({
    capabilities: Schema.optional(Schema.Array(Schema.String)),
    count: Schema.optional(Schema.Union(Schema.String, Schema.Int)),
    device_ids: Schema.optional(Schema.Array(Schema.String)),
    driver: Schema.optional(Schema.String),
    options: Schema.optional(ComposeScalarMapField),
  }),
  ExtensionFields,
);
export type ComposeGpuRequest = typeof ComposeGpuRequest.Type;

export const ComposeGpusField = Schema.Union(
  Schema.Literal("all"),
  Schema.Array(ComposeGpuRequest),
).annotations({
  description:
    'GPU access as the Compose literal "all" or a device-request list; canonical output preserves "all" or uses device objects with options canonicalized to maps.',
});
export type ComposeGpus = typeof ComposeGpusField.Type;

const ResourceCpu = Schema.Union(Schema.Number, Schema.String);
const ResourcePids = Schema.Union(Schema.Int, Schema.String);

export const ComposeResourceLimits = Schema.extend(
  Schema.Struct({
    cpus: Schema.optional(ResourceCpu),
    memory: Schema.optional(Schema.Int),
    pids: Schema.optional(ResourcePids),
  }),
  ExtensionFields,
);
export type ComposeResourceLimits = typeof ComposeResourceLimits.Type;

const ComposeResourceLimitsInput = Schema.extend(
  Schema.Struct({
    cpus: Schema.optional(ResourceCpu),
    memory: Schema.optional(ComposeByteSizeField),
    pids: Schema.optional(ResourcePids),
  }),
  ExtensionFields,
);

export const ComposeDeploymentDevice = Schema.extend(
  Schema.Struct({
    capabilities: Schema.Array(Schema.String),
    count: Schema.optional(Schema.Union(Schema.String, Schema.Int)),
    device_ids: Schema.optional(Schema.Array(Schema.String)),
    driver: Schema.optional(Schema.String),
    options: Schema.optional(ComposeScalarMap),
  }),
  ExtensionFields,
);
export type ComposeDeploymentDevice = typeof ComposeDeploymentDevice.Type;

const ComposeDeploymentDeviceInput = Schema.extend(
  Schema.Struct({
    capabilities: Schema.Array(Schema.String),
    count: Schema.optional(Schema.Union(Schema.String, Schema.Int)),
    device_ids: Schema.optional(Schema.Array(Schema.String)),
    driver: Schema.optional(Schema.String),
    options: Schema.optional(ComposeScalarMapField),
  }),
  ExtensionFields,
);

export const ComposeDiscreteResourceSpec = Schema.extend(
  Schema.Struct({
    kind: Schema.optional(Schema.String),
    value: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  }),
  ExtensionFields,
);
export type ComposeDiscreteResourceSpec = typeof ComposeDiscreteResourceSpec.Type;

export const ComposeGenericResource = Schema.extend(
  Schema.Struct({
    discrete_resource_spec: Schema.optional(ComposeDiscreteResourceSpec),
  }),
  ExtensionFields,
);
export type ComposeGenericResource = typeof ComposeGenericResource.Type;

export const ComposeResourceReservations = Schema.extend(
  Schema.Struct({
    cpus: Schema.optional(ResourceCpu),
    memory: Schema.optional(Schema.Int),
    devices: Schema.optional(Schema.Array(ComposeDeploymentDevice)),
    generic_resources: Schema.optional(Schema.Array(ComposeGenericResource)),
  }),
  ExtensionFields,
);
export type ComposeResourceReservations = typeof ComposeResourceReservations.Type;

const ComposeResourceReservationsInput = Schema.extend(
  Schema.Struct({
    cpus: Schema.optional(ResourceCpu),
    memory: Schema.optional(ComposeByteSizeField),
    devices: Schema.optional(Schema.Array(ComposeDeploymentDeviceInput)),
    generic_resources: Schema.optional(Schema.Array(ComposeGenericResource)),
  }),
  ExtensionFields,
);

export const ComposeDeployResources = Schema.extend(
  Schema.Struct({
    limits: Schema.optional(ComposeResourceLimits),
    reservations: Schema.optional(ComposeResourceReservations),
  }),
  ExtensionFields,
);
export type ComposeDeployResources = typeof ComposeDeployResources.Type;

const ComposeDeployResourcesInput = Schema.extend(
  Schema.Struct({
    limits: Schema.optional(ComposeResourceLimitsInput),
    reservations: Schema.optional(ComposeResourceReservationsInput),
  }),
  ExtensionFields,
);

export const ComposeDeploy = Schema.Struct({
  resources: Schema.optional(ComposeDeployResources),
});
export type ComposeDeploy = typeof ComposeDeploy.Type;

const ComposeDeployInput = Schema.Struct({
  resources: Schema.optional(ComposeDeployResourcesInput),
});

const ComposeDeployObjectField = Schema.transformOrFail(
  ComposeDeployInput,
  Schema.UndefinedOr(ComposeDeploy),
  {
    strict: true,
    decode: (input) =>
      ParseResult.succeed(input.resources === undefined ? {} : { resources: input.resources }),
    encode: (input) => ParseResult.succeed(input ?? {}),
  },
);

export const ComposeDeployField = Schema.Union(ComposeDeployObjectField, Schema.Null).annotations({
  description:
    "Deployment resources as null or a limits and reservations object; canonicalized to resources-only data with memory in bytes and device options as maps.",
});
