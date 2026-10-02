import { SchemaIssue } from "effect";
import { Effect, SchemaTransformation } from "effect";
import { Schema } from "effect";

import { BuildScript } from "./artifacts.ts";
import { buildBlockJsonSchema } from "./build-block-json-schema.ts";

const COMPOSE_BUILD_NORMALIZED_KEYS = [
  "args",
  "context",
  "dockerfile",
  "dockerfile_inline",
  "target",
] as const;

const COMPOSE_BUILD_REJECTED_LITERAL_KEYS = [
  "additional_contexts",
  "cache_from",
  "cache_to",
  "entitlements",
  "extra_hosts",
  "isolation",
  "labels",
  "network",
  "no_cache",
  "no_cache_filter",
  "platforms",
  "privileged",
  "provenance",
  "pull",
  "sbom",
  "secrets",
  "shm_size",
  "ssh",
  "tags",
  "ulimits",
] as const;

const COMPOSE_BUILD_EXTENSION_KEY_PREFIX = "x-";

const anti = () => Schema.optionalKey(Schema.Never);

const LandoBuildBlock = Schema.Struct({
  artifact: Schema.optionalKey(BuildScript),
  app: Schema.optionalKey(BuildScript),
  context: anti(),
  dockerfile: anti(),
  dockerfileInline: anti(),
  args: anti(),
  target: anti(),
});

const ComposeBuildBlock = Schema.Struct({
  context: Schema.String,
  dockerfile: Schema.optionalKey(Schema.String),
  dockerfileInline: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  target: Schema.optionalKey(Schema.String),
  artifact: anti(),
  app: anti(),
});

const BuildBlockCanonical = Schema.Union([LandoBuildBlock, ComposeBuildBlock]);

const BuildBlockObjectFields = {
  artifact: Schema.optionalKey(BuildScript),
  app: Schema.optionalKey(BuildScript),
  additional_contexts: Schema.optionalKey(Schema.Unknown),
  context: Schema.optionalKey(Schema.String),
  dockerfile: Schema.optionalKey(Schema.String),
  dockerfile_inline: Schema.optionalKey(Schema.String),
  dockerfileInline: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Null])),
      Schema.Array(Schema.String),
    ]),
  ),
  cache_from: Schema.optionalKey(Schema.Unknown),
  cache_to: Schema.optionalKey(Schema.Unknown),
  entitlements: Schema.optionalKey(Schema.Unknown),
  extra_hosts: Schema.optionalKey(Schema.Unknown),
  isolation: Schema.optionalKey(Schema.Unknown),
  labels: Schema.optionalKey(Schema.Unknown),
  network: Schema.optionalKey(Schema.Unknown),
  no_cache: Schema.optionalKey(Schema.Unknown),
  no_cache_filter: Schema.optionalKey(Schema.Unknown),
  platforms: Schema.optionalKey(Schema.Unknown),
  privileged: Schema.optionalKey(Schema.Unknown),
  provenance: Schema.optionalKey(Schema.Unknown),
  pull: Schema.optionalKey(Schema.Unknown),
  sbom: Schema.optionalKey(Schema.Unknown),
  secrets: Schema.optionalKey(Schema.Unknown),
  shm_size: Schema.optionalKey(Schema.Unknown),
  ssh: Schema.optionalKey(Schema.Unknown),
  tags: Schema.optionalKey(Schema.Unknown),
  target: Schema.optionalKey(Schema.String),
  ulimits: Schema.optionalKey(Schema.Unknown),
} as const;

const BuildBlockObjectFrom = Schema.Struct(BuildBlockObjectFields).pipe((self) =>
  Schema.StructWithRest(self, [
    Schema.Record(
      Schema.TemplateLiteral([COMPOSE_BUILD_EXTENSION_KEY_PREFIX, Schema.String]),
      Schema.Unknown,
    ),
  ]),
);

const BUILD_BLOCK_DESCRIPTION =
  'Build configuration using either Lando build-script keys (artifact, app) or Compose image-build keys (context, dockerfile, dockerfile_inline, args, target); mixing the families is rejected. Compose accepts a bare context string and defaults an omitted object context to ".". The canonical decoded form keeps dockerfileInline and encodes it back to dockerfile_inline.';

const BuildBlockFrom = Schema.Union([Schema.String, BuildBlockObjectFrom]).annotate({
  description: BUILD_BLOCK_DESCRIPTION,
  jsonSchema: buildBlockJsonSchema,
});

type BuildBlockShape = typeof BuildBlockCanonical.Type;

type BuildBlockInput = typeof BuildBlockFrom.Type;

const landoKeys = ["artifact", "app"] as const;

const fail = (input: BuildBlockInput, message: string): never => {
  throw new SchemaIssue.InvalidValue({ message: message }, input);
};

const decodeBuildBlock = (input: BuildBlockInput): BuildBlockShape => {
  if (typeof input === "string") return { context: input };

  const composeFound = [
    ...COMPOSE_BUILD_NORMALIZED_KEYS.filter((key) => input[key] !== undefined),
    ...COMPOSE_BUILD_REJECTED_LITERAL_KEYS.filter((key) => input[key] !== undefined),
    ...(input.dockerfileInline === undefined ? [] : ["dockerfileInline"]),
    ...Object.keys(input).filter((key) => key.startsWith(COMPOSE_BUILD_EXTENSION_KEY_PREFIX)),
  ];
  const landoFound = landoKeys.filter((key) => input[key] !== undefined);

  if (composeFound.length > 0 && landoFound.length > 0) {
    return fail(
      input,
      `Landofile service "build" mixes two key families: Compose image-build keys (${composeFound.join(", ")}) and Lando build-script keys (${landoFound.join(", ")}). A build block belongs to exactly one family. Either keep the Compose keys and remove ${landoFound.join("/")}, then use image: for the built image in the script-consuming service; or keep ${landoFound.join("/")} and remove ${composeFound.join(", ")}, building the image separately and referencing it with image:.`,
    );
  }

  if (composeFound.length === 0 && landoFound.length === 0) {
    return fail(
      input,
      'Landofile service "build" is empty. Provide Compose image-build keys (context, dockerfile, dockerfile_inline, args, target) or Lando build-script keys (artifact, app).',
    );
  }

  if (landoFound.length > 0) {
    return {
      ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
      ...(input.app === undefined ? {} : { app: input.app }),
    };
  }

  const rejectedFound = [
    ...COMPOSE_BUILD_REJECTED_LITERAL_KEYS.filter((key) => input[key] !== undefined),
    ...Object.keys(input).filter((key) => key.startsWith(COMPOSE_BUILD_EXTENSION_KEY_PREFIX)),
  ];
  if (rejectedFound.length > 0) {
    return fail(input, `Unsupported Compose build key(s): ${rejectedFound.join(", ")}.`);
  }

  if (
    input.dockerfile !== undefined &&
    (input.dockerfile_inline !== undefined || input.dockerfileInline !== undefined)
  ) {
    return fail(
      input,
      'Landofile service "build" sets both "dockerfile" and "dockerfile_inline". Keep exactly one.',
    );
  }

  if (input.dockerfile_inline !== undefined && input.dockerfileInline !== undefined) {
    return fail(
      input,
      'Landofile service "build" sets both "dockerfile_inline" and its canonical form "dockerfileInline". Keep "dockerfile_inline".',
    );
  }

  let args: Readonly<Record<string, string>> | undefined;
  if (Array.isArray(input.args)) {
    const entries: Array<readonly [string, string]> = [];
    for (const entry of input.args) {
      const i = entry.indexOf("=");
      if (i <= 0) {
        return fail(
          input,
          `Landofile service "build.args" entry "${entry}" is missing a "=" separator. Use "KEY=value".`,
        );
      }
      entries.push([entry.slice(0, i), entry.slice(i + 1)]);
    }
    args = Object.fromEntries(entries);
  } else if (input.args !== undefined) {
    const entries: Array<readonly [string, string]> = [];
    for (const [key, value] of Object.entries(input.args)) {
      if (value === null) {
        return fail(
          input,
          `Landofile service "build.args.${key}" must be a string. Null and empty values are not resolved from the host environment.`,
        );
      }
      entries.push([key, value]);
    }
    args = Object.fromEntries(entries);
  }

  const dockerfileInline = input.dockerfile_inline ?? input.dockerfileInline;
  return {
    context: input.context ?? ".",
    ...(input.dockerfile === undefined ? {} : { dockerfile: input.dockerfile }),
    ...(dockerfileInline === undefined ? {} : { dockerfileInline }),
    ...(args === undefined ? {} : { args }),
    ...(input.target === undefined ? {} : { target: input.target }),
  };
};

const encodeBuildBlock = (input: BuildBlockShape): BuildBlockInput => {
  const { dockerfileInline, ...rest } = input;
  return {
    ...rest,
    ...(dockerfileInline === undefined ? {} : { dockerfile_inline: dockerfileInline }),
  };
};

export const BuildBlock = BuildBlockFrom.pipe(
  Schema.decodeTo(
    BuildBlockCanonical,
    SchemaTransformation.transformEffect({
      decode: (input) => {
        try {
          return Effect.succeed(decodeBuildBlock(input));
        } catch (error) {
          if (error instanceof SchemaIssue.InvalidValue) return Effect.fail(error);
          throw error;
        }
      },
      encode: (input) => Effect.succeed(encodeBuildBlock(input)),
    }),
  ),
).annotate({
  description: BUILD_BLOCK_DESCRIPTION,
});
