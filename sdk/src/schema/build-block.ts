import { ParseResult, Schema } from "effect";

import { BuildScript } from "./artifacts.ts";

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

const BuildBlockFrom = Schema.Union(
  Schema.String,
  Schema.Struct({
    artifact: Schema.optional(BuildScript),
    app: Schema.optional(BuildScript),
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
    target: Schema.optional(Schema.String),
  }),
);

export type BuildBlockShape = typeof BuildBlockCanonical.Type;
export type ComposeBuildShape = typeof ComposeBuildBlock.Type;
export type LandoBuildShape = typeof LandoBuildBlock.Type;

type BuildBlockInput = typeof BuildBlockFrom.Type;

const composeKeys = [
  "context",
  "dockerfile",
  "dockerfile_inline",
  "dockerfileInline",
  "args",
  "target",
] as const;
const landoKeys = ["artifact", "app"] as const;

const fail = (input: BuildBlockInput, message: string): never => {
  throw new ParseResult.Type(BuildBlockFrom.ast, input, message);
};

const decodeBuildBlock = (input: BuildBlockInput): BuildBlockShape => {
  if (typeof input === "string") return { context: input };

  const composeFound = composeKeys.filter((key) => input[key] !== undefined);
  const landoFound = landoKeys.filter((key) => input[key] !== undefined);

  if (composeFound.length > 0 && landoFound.length > 0) {
    return fail(
      input,
      `Landofile service "build" mixes two key families: Compose image-build keys (${composeFound.join(", ")}) and Lando build-script keys (${landoFound.join(", ")}). A build block belongs to exactly one family. Either keep the Compose keys and remove ${landoFound.join("/")} — moving those scripts to a service that consumes the built image — or keep ${landoFound.join("/")} and remove ${composeFound.join(", ")}, expressing the image build with build.dockerfile or build.dockerfile_inline instead.`,
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
