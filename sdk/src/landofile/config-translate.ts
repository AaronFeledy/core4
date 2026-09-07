import { Either, Match, Schema } from "effect";
import { ConfigTranslateError } from "../errors/config.ts";
import type {
  ConfigTranslateDiagnostic,
  ConfigTranslateInput,
  ConfigTranslateResult,
} from "../schema/config-translate.ts";
import { LandofileAuthoringFragment } from "../schema/landofile-authoring.ts";

// ==== Input membership and selection invariants
const invalid = (message: string, remediation: string) =>
  Either.left(new ConfigTranslateError({ message, remediation }));

export const declaredConfigTranslateSourceIds = (input: ConfigTranslateInput): ReadonlySet<string> =>
  Match.value(input).pipe(
    Match.tag(
      "landofile-document-set",
      ({ documents }) => new Set<string>(documents.map(({ sourceId }) => sourceId)),
    ),
    Match.tag("recipe-request", ({ sourceId }) => new Set<string>([sourceId])),
    Match.exhaustive,
  );

export const validateConfigTranslateInput = (
  input: ConfigTranslateInput,
): Either.Either<ConfigTranslateInput, ConfigTranslateError> =>
  Match.value(input).pipe(
    Match.tag("recipe-request", () => Either.right(input)),
    Match.tag("landofile-document-set", (request) => {
      const declared = declaredConfigTranslateSourceIds(request);
      if (declared.size !== request.documents.length)
        return invalid(
          "Document source identities must be unique.",
          "Assign a distinct sourceId to each input document.",
        );
      if (request.mode === "single-layer" && request.selectedSourceIds.length === 0)
        return invalid(
          "Single-layer translation requires a selection.",
          "Select at least one input source or request full translation.",
        );
      if (request.selectedSourceIds.some((id) => !declared.has(id)))
        return invalid(
          "The selection names an undeclared source.",
          "Select only sourceIds present in the input documents.",
        );
      if (request.writableLayerIds.length === 0)
        return invalid(
          "No writable target layers were declared.",
          "Declare at least one writable Landofile layer.",
        );
      return Either.right(input);
    }),
    Match.exhaustive,
  );

// ==== Stable provenance ordering
const compareKeyPaths = (
  left: ConfigTranslateDiagnostic["keyPath"],
  right: ConfigTranslateDiagnostic["keyPath"],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a !== typeof b) return typeof a === "number" ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return left.length - right.length;
};

const ordered = <A>(values: readonly A[], compare: (left: A, right: A) => number): boolean =>
  values.every((value, index) => {
    const previous = values[index - 1];
    return previous === undefined || compare(previous, value) <= 0;
  });

// ==== Output ownership and authoring validation
export const validateConfigTranslateResult = (
  input: ConfigTranslateInput,
  result: ConfigTranslateResult,
): Either.Either<ConfigTranslateResult, ConfigTranslateError> => {
  const declared = declaredConfigTranslateSourceIds(input);
  const sourceIds = [...declared];
  const mentioned = [
    ...result.outputs.flatMap((output) => output.sourceIds),
    ...result.diagnostics.map((diagnostic) => diagnostic.sourceId),
    ...result.deletions.map((deletion) => deletion.sourceId),
  ];
  if (mentioned.some((id) => !declared.has(id)))
    return invalid(
      "Translation refers to an undeclared source.",
      "Attribute every output, diagnostic, and deletion to an input sourceId.",
    );
  const targets = result.outputs.map((output) => output.targetLayer);
  if (new Set(targets).size !== targets.length)
    return invalid(
      "Translation emits duplicate target layers.",
      "Fold outputs into one fragment per target layer.",
    );
  const ownership = Match.value(input).pipe(
    Match.tag("landofile-document-set", ({ writableLayerIds }) =>
      targets.every((target) => writableLayerIds.includes(target))
        ? Either.right(result)
        : invalid(
            "Translation targets a layer outside the writable allowlist.",
            "Emit only layers declared in writableLayerIds.",
          ),
    ),
    Match.tag("recipe-request", () => {
      if (result.deletions.length > 0)
        return invalid(
          "Recipe requests cannot propose deletions.",
          "Remove deletion intents from the recipe result.",
        );
      if (targets.length > 1)
        return invalid(
          "Recipe requests may emit only one target layer.",
          "Fold the recipe output into a single Landofile layer.",
        );
      return Either.right(result);
    }),
    Match.exhaustive,
  );
  if (Either.isLeft(ownership)) return ownership;
  const compareSource = (left: string, right: string) => sourceIds.indexOf(left) - sourceIds.indexOf(right);
  if (
    !ordered(
      result.diagnostics,
      (left, right) =>
        compareSource(left.sourceId, right.sourceId) ||
        (left.span?.start.line ?? 0) - (right.span?.start.line ?? 0) ||
        (left.span?.start.column ?? 0) - (right.span?.start.column ?? 0) ||
        compareKeyPaths(left.keyPath, right.keyPath),
    )
  )
    return invalid(
      "Translation diagnostics are out of source order.",
      "Order diagnostics by input document, span start line and column, then key path; unlocated diagnostics sort first.",
    );
  if (!ordered(result.deletions, (left, right) => compareSource(left.sourceId, right.sourceId)))
    return invalid(
      "Deletion intents are out of source order.",
      "Order deletion intents by input document order.",
    );
  for (const output of result.outputs) {
    if (output.sourceIds.length === 0)
      return invalid(
        "Translation output is missing source identities.",
        "Attribute every output to at least one input sourceId.",
      );
    const fragment = Schema.decodeUnknownEither(LandofileAuthoringFragment)(output.fragment, {
      onExcessProperty: "error",
    });
    if (Either.isLeft(fragment))
      return invalid(
        "Translation emitted an invalid authoring fragment.",
        "Emit only supported Landofile authoring fields and expressions with the expected field type.",
      );
  }
  return Either.right(result);
};
