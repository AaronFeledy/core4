/**
 * The canonical v4 Landofile codec.
 *
 * Decode parses a core-ordered set of bounded v4 YAML documents into authoring
 * fragments; encode serializes an authoring value back to tag-free block-style
 * YAML through the canonical serializer. Neither direction resolves environment
 * values, secrets, files, provider data, includes, `.lando.ts`, or commands:
 * expressions survive as their verbatim source text.
 */
import { Effect, Result, Schema } from "effect";

import { ConfigTranslateError } from "@lando/sdk/errors";
import { emitLandofileYamlEither, parseLandofile, validateConfigTranslateInput } from "@lando/sdk/landofile";
import type {
  ConfigTranslateDetectInput,
  ConfigTranslateDiagnostic,
  ConfigTranslateDocument,
  ConfigTranslateEncodeInput,
  ConfigTranslateEncodeResult,
  ConfigTranslateInput,
  ConfigTranslateMatch,
  ConfigTranslateOutput,
  ConfigTranslateResult,
  LandofileLayer as LandofileLayerId,
} from "@lando/sdk/schema";
import { LandofileAuthoringFragment, LandofileAuthoringShape, LandofileLayer } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";

/** Translator id; must match the `configTranslators` contribution id. */
export const LANDO4_TRANSLATOR_ID = "lando4";

const SUMMARY = "Canonical v4 Landofile YAML decoder and expression-aware encoder.";

/** Media types core assigns to canonical `.yml` / `.yaml` Landofile layers. */
const YAML_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "text/x-yaml",
]);

type AuthoringFragmentWire = ConfigTranslateOutput["fragment"];

const isLandofileLayer = Schema.is(LandofileLayer);
const decodeFragment = Schema.decodeUnknownEffect(LandofileAuthoringFragment);
const decodeShape = Schema.decodeUnknownEffect(LandofileAuthoringShape);
const encodeFragment = Schema.encodeEffect(LandofileAuthoringFragment);
const encodeShape = Schema.encodeEffect(LandofileAuthoringShape);
const decodeRecord = Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown));

const translateError = (message: string, remediation?: string, cause?: unknown): ConfigTranslateError =>
  new ConfigTranslateError({
    message,
    translator: LANDO4_TRANSLATOR_ID,
    ...(remediation === undefined ? {} : { remediation }),
    ...(cause === undefined ? {} : { cause }),
  });

const asTranslateError =
  (message: string) =>
  (cause: { readonly message: string }): ConfigTranslateError =>
    translateError(`${message} ${cause.message}`, undefined, cause);

/** One root-scoped diagnostic; the empty key path leaves input order as the only sort key. */
const rootDiagnostic = (
  document: ConfigTranslateDocument,
  kind: ConfigTranslateDiagnostic["kind"],
  message: string,
  remediation?: string,
): ConfigTranslateDiagnostic => ({
  kind,
  sourceId: document.sourceId,
  keyPath: [],
  message,
  ...(remediation === undefined ? {} : { remediation }),
});

const describe = (document: ConfigTranslateDocument): string => document.path ?? String(document.sourceId);

/** Decode bounded raw bytes as UTF-8; the translator never touches the filesystem. */
const readText = (document: ConfigTranslateDocument): Result.Result<string, string> => {
  try {
    return Result.succeed(new TextDecoder("utf-8", { fatal: true }).decode(document.bytes));
  } catch (cause) {
    return Result.fail(`${describe(document)} is not valid UTF-8 text: ${String(cause)}`);
  }
};

/**
 * Parse one bounded document into an authoring wire fragment. A rejection is a
 * message rather than a failure channel so one bad document becomes an
 * `unsupported` diagnostic instead of aborting the whole set.
 */
const parseDocument = (
  document: ConfigTranslateDocument,
): Effect.Effect<Result.Result<AuthoringFragmentWire, string>, never, never> => {
  if (!YAML_MEDIA_TYPES.has(document.mediaType)) {
    return Effect.succeed(
      Result.fail(
        `${describe(document)} is not canonical v4 YAML (media type ${document.mediaType}); TypeScript Landofiles and includes stay opaque and are never executed.`,
      ),
    );
  }
  const text = readText(document);
  if (Result.isFailure(text)) return Effect.succeed(Result.fail(text.failure));
  return parseLandofile({ file: describe(document), content: text.success, cwd: "." }).pipe(
    Effect.flatMap((value) => decodeFragment(value, { onExcessProperty: "error" })),
    Effect.flatMap(encodeFragment),
    Effect.match({
      onSuccess: (wire): Result.Result<AuthoringFragmentWire, string> => Result.succeed(wire),
      onFailure: (cause): Result.Result<AuthoringFragmentWire, string> =>
        Result.fail(`${describe(document)} is not valid canonical v4 authoring data: ${cause.message}`),
    }),
  );
};

interface DecodedDocument {
  readonly document: ConfigTranslateDocument;
  readonly layer: LandofileLayerId;
  readonly wire: AuthoringFragmentWire;
}

const detect = Effect.fn("Lando4ConfigTranslator.detect")(function* (
  input: ConfigTranslateDetectInput,
): Effect.fn.Return<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError, never> {
  const candidates = input.documents.filter((document) => YAML_MEDIA_TYPES.has(document.mediaType));
  if (candidates.length === 0) return [];
  let marked = false;
  for (const document of candidates) {
    const parsed = yield* parseDocument(document);
    if (Result.isFailure(parsed)) return [];
    // `runtime: 4` is the one marker a Lando 3 document cannot carry, so it is
    // the sole basis for `exact`. Anything else that survives strict v4
    // authoring decoding is only `likely`.
    marked ||= typeof parsed.success === "object" && Reflect.get(parsed.success, "runtime") === 4;
  }
  return [
    {
      translator: LANDO4_TRANSLATOR_ID,
      sourceIds: candidates.map((document) => document.sourceId),
      confidence: marked ? "exact" : "likely",
      summary: SUMMARY,
    },
  ];
});

const translate = Effect.fn("Lando4ConfigTranslator.translate")(function* (
  input: ConfigTranslateInput,
): Effect.fn.Return<ConfigTranslateResult, ConfigTranslateError, never> {
  if (input._tag === "recipe-request") {
    return yield* Effect.fail(
      translateError(
        "The lando4 translator decodes canonical v4 Landofile document sets, not recipe requests.",
        "Select the recipe translator for a recipe request.",
      ),
    );
  }
  yield* Effect.fromResult(validateConfigTranslateInput(input));
  const writable = new Set<string>(input.writableLayerIds);
  const selectedIds = new Set<string>(input.selectedSourceIds);
  // Non-selected documents in single-layer mode are validation context, not
  // omitted input, so they yield neither an output nor a diagnostic.
  const selected = input.documents.filter(
    (document) => input.mode === "full" || selectedIds.has(document.sourceId),
  );

  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const decoded: DecodedDocument[] = [];
  for (const document of selected) {
    const parsed = yield* parseDocument(document);
    if (Result.isFailure(parsed)) {
      diagnostics.push(rootDiagnostic(document, "unsupported", parsed.failure));
      continue;
    }
    if (!isLandofileLayer(document.layerId)) {
      diagnostics.push(
        rootDiagnostic(
          document,
          "unsupported",
          `${describe(document)} claims layer ${document.layerId}, which is not a v4 Landofile layer.`,
        ),
      );
      continue;
    }
    decoded.push({ document, layer: document.layerId, wire: parsed.success });
  }

  const claimants = new Map<string, ReadonlyArray<DecodedDocument>>();
  for (const entry of decoded) {
    claimants.set(entry.layer, [...(claimants.get(entry.layer) ?? []), entry]);
  }

  const outputs: ConfigTranslateOutput[] = [];
  for (const entry of decoded) {
    const sharing = claimants.get(entry.layer) ?? [];
    if (sharing.length > 1) {
      diagnostics.push(
        rootDiagnostic(
          entry.document,
          "unsupported",
          `Layer ${entry.layer} is claimed by ${sharing
            .map(({ document }) => describe(document))
            .join(", ")}; a v4 layer owns exactly one document.`,
          "Remove the duplicate layer document and translate again.",
        ),
      );
      continue;
    }
    if (!writable.has(entry.layer)) {
      diagnostics.push(
        rootDiagnostic(
          entry.document,
          "dropped",
          `${describe(entry.document)} is already canonical v4 at the ${entry.layer} layer, which this request cannot write, so it was omitted from the output set.`,
          `Include ${entry.layer} in the writable layers to emit it.`,
        ),
      );
      continue;
    }
    outputs.push({
      targetLayer: entry.layer,
      fragment: entry.wire,
      sourceIds: [entry.document.sourceId],
    });
  }

  const sourceOrder = new Map(input.documents.map((document, index) => [document.sourceId, index]));
  diagnostics.sort(
    (left, right) => (sourceOrder.get(left.sourceId) ?? 0) - (sourceOrder.get(right.sourceId) ?? 0),
  );
  return { outputs, diagnostics, deletions: [] };
});

const encode = Effect.fn("Lando4ConfigTranslator.encode")(function* (
  input: ConfigTranslateEncodeInput,
): Effect.fn.Return<ConfigTranslateEncodeResult, ConfigTranslateError, never> {
  // The context is the already-merged complete authoring tree. It must be a
  // concrete mapping even when only a fragment is emitted; a root expression
  // is not a Landofile. Only the fragment wire tree reaches the emitter, so
  // lower layers are never flattened.
  const context = yield* decodeShape(input.context, { onExcessProperty: "error" }).pipe(
    Effect.mapError(asTranslateError("The lando4 encoder requires a complete authoring context:")),
  );
  const contextWire = yield* encodeShape(context).pipe(
    Effect.mapError(asTranslateError("The lando4 encoder requires a complete authoring context:")),
  );
  yield* decodeRecord(contextWire).pipe(
    Effect.mapError(asTranslateError("The lando4 encoder requires a Landofile mapping at the root:")),
  );
  const wire = yield* (
    input.fragment === undefined
      ? Effect.succeed(contextWire)
      : decodeFragment(input.fragment, { onExcessProperty: "error" }).pipe(Effect.flatMap(encodeFragment))
  ).pipe(Effect.mapError(asTranslateError("The lando4 encoder received a non-authoring value:")));
  const record = yield* decodeRecord(wire).pipe(
    Effect.mapError(asTranslateError("The lando4 encoder requires a Landofile mapping at the root:")),
  );
  const emitted = emitLandofileYamlEither(record, { sortKeys: true, leadingCommentBlock: "editor-schema" });
  if (Result.isFailure(emitted)) {
    return yield* Effect.fail(translateError(emitted.failure.message, undefined, emitted.failure));
  }
  return { text: emitted.success, diagnostics: [] };
});

export const lando4ConfigTranslator: ConfigTranslatorShape = {
  id: LANDO4_TRANSLATOR_ID,
  summary: SUMMARY,
  inputKinds: [LANDO4_TRANSLATOR_ID],
  detect,
  translate,
  encode,
};

export default lando4ConfigTranslator;
