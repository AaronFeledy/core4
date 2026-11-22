import {
  LandofileAuthoringShape,
  LandofileShape,
  getEditorJsonSchema,
  getJsonSchema,
  validationIssuesFromSchemaIssue,
} from "@lando/sdk/schema";
import { LandofileStandardJSONSchema, LandofileStandardSchema } from "@lando/sdk/schema/standard";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { Result, Schema } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

/** Ajv options: no coercion, defaults, or additional-property stripping. */
export const ajvOptions = {
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
} as const;

export const parseOptions = { onExcessProperty: "error", errors: "all" } as const;

export type AuthoringVerdicts = {
  readonly decode: boolean;
  readonly standard: boolean;
  readonly editor: boolean;
  readonly standard07: boolean;
  readonly standard2020: boolean;
  readonly authoring: boolean;
};

export type RuntimeVerdicts = {
  readonly decode: boolean;
  readonly runtime: boolean;
};

export type LandofileParityValidators = {
  readonly editor: ReturnType<Ajv["compile"]>;
  readonly standard07: ReturnType<Ajv["compile"]>;
  readonly standard2020: ReturnType<Ajv2020["compile"]>;
  readonly authoring: ReturnType<Ajv2020["compile"]>;
  readonly runtime: ReturnType<Ajv2020["compile"]>;
};

let cached: LandofileParityValidators | undefined;

/** Compile each published Landofile dialect once per process. */
export const landofileParityValidators = (): LandofileParityValidators => {
  if (cached) return cached;
  const draft07 = new Ajv(ajvOptions);
  const draft2020 = new Ajv2020(ajvOptions);
  const standard = LandofileStandardJSONSchema["~standard"].jsonSchema;
  cached = {
    editor: draft07.compile(getEditorJsonSchema("LandofileShape")),
    standard07: draft07.compile(standard.input({ target: "draft-07" })),
    standard2020: draft2020.compile(standard.input({ target: "draft-2020-12" })),
    authoring: draft2020.compile(getJsonSchema("LandofileAuthoringShape")),
    runtime: draft2020.compile(getJsonSchema("LandofileShape")),
  };
  return cached;
};

export const decodeAuthoring = Schema.decodeUnknownResult(LandofileAuthoringShape);
export const decodeRuntime = Schema.decodeUnknownResult(LandofileShape);

export async function authoringVerdicts(
  input: unknown,
  validators: LandofileParityValidators = landofileParityValidators(),
): Promise<AuthoringVerdicts> {
  const decoded = decodeAuthoring(input, parseOptions);
  const standard = await LandofileStandardSchema["~standard"].validate(input);
  return {
    decode: Result.isSuccess(decoded),
    standard: standard.issues === undefined,
    editor: !!validators.editor(input),
    standard07: !!validators.standard07(input),
    standard2020: !!validators.standard2020(input),
    authoring: !!validators.authoring(input),
  };
}

export function runtimeVerdicts(
  input: unknown,
  validators: LandofileParityValidators = landofileParityValidators(),
): RuntimeVerdicts {
  return {
    decode: Result.isSuccess(decodeRuntime(input, parseOptions)),
    runtime: !!validators.runtime(input),
  };
}

/** All authoring stages share one boolean. */
export const uniformAuthoring = (accepted: boolean): AuthoringVerdicts => ({
  decode: accepted,
  standard: accepted,
  editor: accepted,
  standard07: accepted,
  standard2020: accepted,
  authoring: accepted,
});

/** Decoder/standard reject while every published authoring document accepts (runtime-only / inexpressible). */
export const runtimeOnlyAuthoring = {
  decode: false,
  standard: false,
  editor: true,
  standard07: true,
  standard2020: true,
  authoring: true,
} as const satisfies AuthoringVerdicts;

export function issueDetails(issues: readonly StandardSchemaV1.Issue[]) {
  return issues.map(({ message, path }) => ({
    message,
    path: (path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment)),
  }));
}

export function decoderIssues(decoded: Result.Result<unknown, Schema.SchemaError>, input: unknown) {
  return Result.isFailure(decoded)
    ? issueDetails(validationIssuesFromSchemaIssue(decoded.failure.issue, { input }))
    : [];
}

export function serviceWith(fields: object) {
  return { name: "demo", services: { web: { type: "node:22", ...fields } } };
}
