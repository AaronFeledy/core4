import { Schema } from "effect";

// ==== Supported Compose service fields (SPEC: §6.2, §7.4) ====

const ComposeExtensionRecord = Schema.Record({
  key: Schema.TemplateLiteral("x-", Schema.String),
  value: Schema.Unknown,
});

const ComposeStringList = Schema.Array(Schema.String)
  .pipe(
    Schema.filter((values) => new Set(values).size === values.length, {
      message: () => "Expected a list of unique strings.",
    }),
  )
  .annotations({ jsonSchema: { uniqueItems: true } });

const ComposeNetworkName = Schema.String.pipe(Schema.pattern(/^[a-zA-Z0-9._-]+$/));

const ComposeNetworkAttachmentBase = Schema.Struct({
  aliases: Schema.optional(ComposeStringList),
  interface_name: Schema.optional(Schema.String),
  ipv4_address: Schema.optional(Schema.String),
  ipv6_address: Schema.optional(Schema.String),
  link_local_ips: Schema.optional(ComposeStringList),
  mac_address: Schema.optional(Schema.String),
  driver_opts: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Number) }),
  ),
  priority: Schema.optional(Schema.Number),
  gw_priority: Schema.optional(Schema.Number),
});

const ComposeNetworkAttachment = Schema.asSchema(
  ComposeNetworkAttachmentBase.pipe(Schema.extend(ComposeExtensionRecord)),
);

export const ComposeServiceNetworks = Schema.Union(
  ComposeStringList,
  Schema.Record({
    key: ComposeNetworkName,
    value: Schema.Union(ComposeNetworkAttachment, Schema.Null),
  }),
).annotations({
  identifier: "ComposeServiceNetworks",
  description: "Compose service network attachments as a unique name list or a name-to-null-or-options map.",
});

const ComposeServiceConfigOrSecretLongBase = Schema.Struct({
  source: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  uid: Schema.optional(Schema.String),
  gid: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
});

const ComposeServiceConfigOrSecretLong = Schema.asSchema(
  ComposeServiceConfigOrSecretLongBase.pipe(Schema.extend(ComposeExtensionRecord)),
);

export const ComposeServiceConfigOrSecret = Schema.Array(
  Schema.Union(Schema.String, ComposeServiceConfigOrSecretLong),
).annotations({
  identifier: "ComposeServiceConfigOrSecret",
  description: "Compose service configs or secrets as string names or long mount objects.",
});

export const ComposeServiceProfiles = ComposeStringList.annotations({
  identifier: "ComposeServiceProfiles",
  description: "Unique Compose profile names that activate a service.",
});

export const ComposeSupportedSubsetFields = {
  networks: Schema.optional(ComposeServiceNetworks).annotations({
    description: "Networks joined by this service, preserving Compose short-list or long-map syntax.",
  }),
  configs: Schema.optional(ComposeServiceConfigOrSecret).annotations({
    description: "Compose configs granted to this service as names or long mount objects.",
  }),
  secrets: Schema.optional(ComposeServiceConfigOrSecret).annotations({
    description: "Compose secrets granted to this service as names or long mount objects.",
  }),
  profiles: Schema.optional(ComposeServiceProfiles).annotations({
    description: "Compose profiles that activate this service.",
  }),
} as const;
