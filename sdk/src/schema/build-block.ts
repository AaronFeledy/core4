import { ParseResult, Schema } from "effect";

import { BuildScript } from "./artifacts.ts";
import {
  COMPOSE_BUILD_EXTENSION_KEY_PREFIX,
  COMPOSE_BUILD_NORMALIZED_KEYS,
  COMPOSE_BUILD_REJECTED_LITERAL_KEYS,
} from "./compose-build-keys.ts";

const anti = () => Schema.optional(Schema.Never);

export const LandoBuildBlock = Schema.Struct({
  artifact: Schema.optional(BuildScript),
  app: Schema.optional(BuildScript),
  context: anti(),
  dockerfile: anti(),
  dockerfileInline: anti(),
  args: anti(),
  target: anti(),
});

export const ComposeBuildBlock = Schema.Struct({
  context: Schema.String,
  dockerfile: Schema.optional(Schema.String),
  dockerfileInline: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  target: Schema.optional(Schema.String),
  artifact: anti(),
  app: anti(),
});

const BuildBlockCanonical = Schema.Union(LandoBuildBlock, ComposeBuildBlock);

const BuildBlockObjectFields = {
  artifact: Schema.optional(BuildScript),
  app: Schema.optional(BuildScript),
  additional_contexts: Schema.optional(Schema.Unknown),
  context: Schema.optional(Schema.String),
  dockerfile: Schema.optional(Schema.String),
  dockerfile_inline: Schema.optional(Schema.String),
  dockerfileInline: Schema.optional(Schema.String),
  args: Schema.optional(
    Schema.Union(
      Schema.Record({ key: Schema.String, value: Schema.Union(Schema.String, Schema.Null) }),
      Schema.Array(Schema.String),
    ),
  ),
  cache_from: Schema.optional(Schema.Unknown),
  cache_to: Schema.optional(Schema.Unknown),
  entitlements: Schema.optional(Schema.Unknown),
  extra_hosts: Schema.optional(Schema.Unknown),
  isolation: Schema.optional(Schema.Unknown),
  labels: Schema.optional(Schema.Unknown),
  network: Schema.optional(Schema.Unknown),
  no_cache: Schema.optional(Schema.Unknown),
  no_cache_filter: Schema.optional(Schema.Unknown),
  platforms: Schema.optional(Schema.Unknown),
  privileged: Schema.optional(Schema.Unknown),
  provenance: Schema.optional(Schema.Unknown),
  pull: Schema.optional(Schema.Unknown),
  sbom: Schema.optional(Schema.Unknown),
  secrets: Schema.optional(Schema.Unknown),
  shm_size: Schema.optional(Schema.Unknown),
  ssh: Schema.optional(Schema.Unknown),
  tags: Schema.optional(Schema.Unknown),
  target: Schema.optional(Schema.String),
  ulimits: Schema.optional(Schema.Unknown),
} as const;

const BuildBlockObjectFrom = Schema.Struct(BuildBlockObjectFields)
  .pipe(
    Schema.extend(
      Schema.Record({
        key: Schema.TemplateLiteral(COMPOSE_BUILD_EXTENSION_KEY_PREFIX, Schema.String),
        value: Schema.Unknown,
      }),
    ),
  )
  .annotations({
    jsonSchema: {
      propertyNames: {
        anyOf: [
          { enum: Object.keys(BuildBlockObjectFields) },
          { pattern: `^${COMPOSE_BUILD_EXTENSION_KEY_PREFIX}` },
        ],
      },
    },
  });

const BuildBlockFrom = Schema.Union(Schema.String, BuildBlockObjectFrom);

export type BuildBlockShape = typeof BuildBlockCanonical.Type;
export type ComposeBuildShape = typeof ComposeBuildBlock.Type;
export type LandoBuildShape = typeof LandoBuildBlock.Type;

type BuildBlockInput = typeof BuildBlockFrom.Type;

const landoKeys = ["artifact", "app"] as const;

const fail = (input: BuildBlockInput, message: string): never => {
  throw new ParseResult.Type(BuildBlockFrom.ast, input, message);
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

export const BuildBlock = Schema.transformOrFail(BuildBlockFrom, BuildBlockCanonical, {
  strict: true,
  decode: (input) => {
    try {
      return ParseResult.succeed(decodeBuildBlock(input));
    } catch (error) {
      if (error instanceof ParseResult.Type) return ParseResult.fail(error);
      throw error;
    }
  },
  encode: (input) => ParseResult.succeed(encodeBuildBlock(input)),
});
