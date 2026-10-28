import { Schema } from "effect";
import { DeprecationNotice } from "./deprecation.ts";
import { LandofileSourceValue } from "./landofile-source.ts";
import { PromptChoice, PromptType } from "./prompt.ts";
import {
  RecipeContentDigest,
  RecipeId,
  RecipeOptionValue,
  RecipePackageName,
  RecipeProducer,
  RecipeSourceKind,
  RecipeVersion,
} from "./recipe-identity.ts";
import { RecipeOptionType, RecipeSnapshotAsset } from "./recipe-snapshot.ts";
import { RecipeFile, RecipePostInitAction, RecipeRequires, RecipeSecretDisposition } from "./recipe.ts";

// ==== Public author input, distinct from historical snapshot data
export const RecipeSourcePrompt = Schema.Struct({
  message: Schema.optionalKey(
    Schema.String.annotate({ description: "Human-facing question; defaults to the option name." }),
  ),
  type: Schema.optionalKey(
    PromptType.annotate({ description: "Presentation control; must agree with the option descriptor." }),
  ),
  validationMessage: Schema.optionalKey(
    Schema.String.annotate({
      description: "Human-facing guidance when the option descriptor rejects an answer.",
    }),
  ),
  choices: Schema.optionalKey(
    Schema.Array(PromptChoice).annotate({ description: "Labels for the descriptor's accepted choices." }),
  ),
  deprecated: Schema.optionalKey(
    DeprecationNotice.annotate({ description: "Deprecation guidance for this question." }),
  ),
}).annotate({
  identifier: "RecipeSourcePrompt",
  description: "Presentation metadata for an authored recipe option.",
});
export type RecipeSourcePrompt = typeof RecipeSourcePrompt.Type;

export const RecipeSourceOption = Schema.Union([
  Schema.Struct({
    drop: Schema.optionalKey(Schema.Never.annotate({ description: "Forbidden on an option declaration." })),
    type: RecipeOptionType.annotate({ description: "Closed nonsecret value descriptor." }),
    default: Schema.optionalKey(
      RecipeOptionValue.annotate({
        description: "Typed default checked against the descriptor during compilation.",
      }),
    ),
    prompt: Schema.optionalKey(
      RecipeSourcePrompt.annotate({ description: "Optional question presentation." }),
    ),
  }),
  Schema.Struct({
    drop: Schema.optionalKey(
      Schema.Never.annotate({ description: "Forbidden on a secret option declaration." }),
    ),
    type: Schema.Struct({
      kind: Schema.Literal("secret").annotate({ description: "Nonpersistable secret discriminator." }),
    }).annotate({ description: "Secret descriptor, never recorded as an option." }),
    disposition: RecipeSecretDisposition.annotate({
      description: "Single approved secret reference or init-only sink.",
    }),
    default: Schema.optionalKey(Schema.Never),
    prompt: Schema.optionalKey(
      RecipeSourcePrompt.annotate({ description: "Optional secret question presentation." }),
    ),
  }),
  Schema.Struct({
    drop: Schema.Literal(true).annotate({
      description: "Remove this option inherited from a parent recipe.",
    }),
    type: Schema.optionalKey(Schema.Never),
    default: Schema.optionalKey(Schema.Never),
    prompt: Schema.optionalKey(Schema.Never),
    disposition: Schema.optionalKey(Schema.Never),
  }),
]).annotate({
  identifier: "RecipeSourceOption",
  description: "Single declaration of an option's type, default and presentation, or secret disposition.",
});
export type RecipeSourceOption = typeof RecipeSourceOption.Type;

const config = Schema.Record(Schema.String, LandofileSourceValue).annotate({
  description:
    "Ordinary authored Landofile mapping, including source expressions and merge directive envelopes; structurally checked by compilation.",
});
export const RecipeConfigLayer = Schema.Struct({
  when: Schema.optionalKey(
    Schema.String.annotate({
      description: "Options-only structural condition; omission means unconditional.",
    }),
  ),
  config,
}).annotate({ identifier: "RecipeConfigLayer", description: "One ordered authored config contribution." });
export type RecipeConfigLayer = typeof RecipeConfigLayer.Type;

export const RecipeSource = Schema.Struct({
  id: RecipeId.annotate({ description: "Recipe identifier." }),
  title: Schema.String.annotate({ description: "Display title." }),
  description: Schema.String.annotate({ description: "Recipe purpose." }),
  version: RecipeVersion.annotate({ description: "Author source version." }),
  package: Schema.optionalKey(
    RecipePackageName.annotate({
      description: "Declared package metadata; trusted producer coordinates come from the caller.",
    }),
  ),
  extends: Schema.optionalKey(
    Schema.String.annotate({ description: "Parent recipe coordinate resolved before compilation." }),
  ),
  options: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^(?!name$)[A-Za-z_][A-Za-z0-9_-]*$/)),
      RecipeSourceOption,
    ).annotate({ description: "Option declarations by name; app name is reserved." }),
  ),
  config,
  variants: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        when: Schema.String.annotate({ description: "Options-only structural condition." }),
        config,
      }),
    ).annotate({ description: "Ordered conditional overlays applied after base config." }),
  ),
  files: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        RecipeFile,
        Schema.Struct({
          dest: Schema.String.annotate({ description: "Inherited file destination to remove." }),
          drop: Schema.Literal(true).annotate({
            description: "Remove the inherited file at this destination.",
          }),
        }),
      ]),
    ).annotate({
      description: "Auxiliary file declarations, without hand-authored digests.",
    }),
  ),
  postInit: Schema.optionalKey(
    Schema.Array(RecipePostInitAction).annotate({ description: "Ordered post-initialization actions." }),
  ),
  authors: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Recipe authors." })),
  tags: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "Discovery tags." })),
  requires: Schema.optionalKey(RecipeRequires.annotate({ description: "Initialization prerequisites." })),
  runs: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Allowed command identifiers." }),
  ),
  fetchAllowlist: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({ description: "Allowed download destinations." }),
  ),
  deprecated: Schema.optionalKey(DeprecationNotice.annotate({ description: "Recipe deprecation guidance." })),
}).annotate({
  identifier: "RecipeSource",
  description: "Public recipe author source. Compilation derives runtime metadata, snapshots and identity.",
});
export type RecipeSource = typeof RecipeSource.Type;

export const RecipeSourceCompileContext = Schema.Struct({
  sourceKind: RecipeSourceKind.annotate({ description: "Trusted producer source family." }),
  packageName: RecipePackageName.annotate({ description: "Trusted producer package coordinate." }),
  assets: Schema.Array(RecipeSnapshotAsset).annotate({
    description: "Observed raw output asset digests.",
  }),
  inputs: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)),
      RecipeContentDigest,
    ).annotate({
      description:
        "Digests of non-output inputs by portable logical identifier, such as postInit.0; never paths or bytes.",
    }),
  ),
  parents: Schema.optionalKey(
    Schema.Array(RecipeProducer).annotate({
      description: "Ordered parent identity and content digest evidence.",
    }),
  ),
  configLayers: Schema.optionalKey(
    Schema.Array(RecipeConfigLayer).annotate({
      description:
        "Complete ordered parent/child base/variant contributions; replaces automatic source layers.",
    }),
  ),
}).annotate({
  identifier: "RecipeSourceCompileContext",
  description: "Portable acquisition evidence consumed by the pure source compiler.",
});
export type RecipeSourceCompileContext = typeof RecipeSourceCompileContext.Type;
