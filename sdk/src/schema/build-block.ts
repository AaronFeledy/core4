import { Effect, Predicate, Schema, SchemaTransformation } from "effect";

import { BuildScript } from "./artifacts.ts";
import { executionSiteKey } from "./execution-site.ts";
import { indexedPropertyNameCheck, propertyNameCheckedRecord } from "./property-name-check.ts";

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

const scriptFields = {
  artifact: executionSiteKey(Schema.optionalKey(BuildScript), "build-artifact"),
  app: executionSiteKey(Schema.optionalKey(BuildScript), "build-app"),
} as const;

const composeFields = {
  context: Schema.optionalKey(Schema.String),
  dockerfile: Schema.optionalKey(Schema.String),
  dockerfile_inline: executionSiteKey(Schema.optionalKey(Schema.String), "build-dockerfile"),
  args: executionSiteKey(
    Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.String),
        Schema.Array(
          Schema.String.check(
            Schema.isPattern(/^[^=]+=/u, { message: 'Use "KEY=value" with a nonempty build argument name.' }),
          ),
        ),
      ]),
    ),
    "build-arg",
  ),
  target: Schema.optionalKey(Schema.String),
} as const;

const presence = Schema.makeFilter(
  (value: unknown) => Predicate.isObject(value) && Object.keys(value).length > 0,
  {
    "lando/authoring-key-presence": true,
    "lando/issue-reason": "build.empty",
    message:
      'Landofile service "build" is empty. Provide Compose image-build keys or Lando build-script keys.',
    toJsonSchema: () => ({ minProperties: 1 }),
  },
);

const ScriptInput = Schema.Struct({
  ...scriptFields,
  context: anti(),
  dockerfile: anti(),
  dockerfile_inline: anti(),
  args: anti(),
  target: anti(),
}).check(presence);

const ComposeInput = Schema.Struct({ ...composeFields, artifact: anti(), app: anti() }).check(
  presence,
  Schema.makeFilter(
    ({ dockerfile, dockerfile_inline }) => dockerfile === undefined || dockerfile_inline === undefined,
    {
      "lando/authoring-key-presence": true,
      "lando/issue-reason": "build.dockerfile-conflict",
      message: 'Landofile service "build" sets both "dockerfile" and "dockerfile_inline". Keep exactly one.',
      toJsonSchema: () => ({ not: { required: ["dockerfile", "dockerfile_inline"] } }),
    },
  ),
);

const knownKeys = indexedPropertyNameCheck(
  new RegExp(`^(?:${Object.keys({ ...composeFields, ...scriptFields }).join("|")})(?![\\s\\S])`, "u"),
  'Unsupported Compose build key. Use a listed build key; spell an inline Dockerfile as "dockerfile_inline".',
  "build.unsupported-key",
);

const BUILD_BLOCK_DESCRIPTION =
  'Build configuration using either Lando build-script keys (artifact, app) or Compose image-build keys (context, dockerfile, dockerfile_inline, args, target); mixing the families is rejected. Compose accepts a bare context string and defaults an omitted object context to ".". The canonical decoded form keeps dockerfileInline and encodes it back to dockerfile_inline.';

const BuildBlockFrom = Schema.Union([
  Schema.String,
  propertyNameCheckedRecord(ScriptInput, knownKeys),
  propertyNameCheckedRecord(ComposeInput, knownKeys),
]).annotate({
  description: BUILD_BLOCK_DESCRIPTION,
  message:
    'Landofile service "build" must use either Compose image-build keys or Lando build-script keys. To use a separately built image with scripts, reference it using image:.',
  // The opposing anti-fields reject the combination; classify it when the union reports it.
  "lando/union-failure-reason": (input: unknown) =>
    Predicate.isObject(input) &&
    Object.keys(scriptFields).some((key) => Object.hasOwn(input, key)) &&
    Object.keys(composeFields).some((key) => Object.hasOwn(input, key))
      ? "build.mixed-families"
      : undefined,
});

type BuildBlockShape = typeof BuildBlockCanonical.Type;

type BuildBlockInput = typeof BuildBlockFrom.Type;

const decodeBuildBlock = (input: BuildBlockInput): BuildBlockShape => {
  if (typeof input === "string") return { context: input };
  if (input.artifact !== undefined || input.app !== undefined) {
    return {
      ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
      ...(input.app === undefined ? {} : { app: input.app }),
    };
  }

  const args = Array.isArray(input.args)
    ? Object.fromEntries(
        input.args.map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
        }),
      )
    : input.args;
  return {
    context: input.context ?? ".",
    ...(input.dockerfile === undefined ? {} : { dockerfile: input.dockerfile }),
    ...(input.dockerfile_inline === undefined ? {} : { dockerfileInline: input.dockerfile_inline }),
    ...(args === undefined ? {} : { args }),
    ...(input.target === undefined ? {} : { target: input.target }),
  };
};

const encodeBuildBlock = (input: BuildBlockShape): BuildBlockInput => {
  if (input.context === undefined) return input;
  return {
    context: input.context,
    ...(input.dockerfile === undefined ? {} : { dockerfile: input.dockerfile }),
    ...(input.dockerfileInline === undefined ? {} : { dockerfile_inline: input.dockerfileInline }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.target === undefined ? {} : { target: input.target }),
  };
};

export const BuildBlock = BuildBlockFrom.pipe(
  Schema.decodeTo(
    BuildBlockCanonical,
    SchemaTransformation.transformEffect({
      decode: (input) => Effect.succeed(decodeBuildBlock(input)),
      encode: (input) => Effect.succeed(encodeBuildBlock(input)),
    }),
  ),
).annotate({
  description: BUILD_BLOCK_DESCRIPTION,
});
