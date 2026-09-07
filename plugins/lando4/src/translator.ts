/**
 * The canonical v4 Landofile codec.
 *
 * Decode parses a core-ordered set of bounded v4 YAML documents into authoring
 * fragments; encode serializes an authoring value back to tag-free block-style
 * YAML through the canonical serializer. Neither direction resolves environment
 * values, secrets, files, provider data, includes, `.lando.ts`, or commands:
 * expressions survive as their verbatim source text.
 */
import { Effect, Either, Schema } from "effect";

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
const decodeFragment = Schema.decodeUnknown(LandofileAuthoringFragment);
const decodeShape = Schema.decodeUnknown(LandofileAuthoringShape);
const encodeFragment = Schema.encode(LandofileAuthoringFragment);
const encodeShape = Schema.encode(LandofileAuthoringShape);
const decodeRecord = Schema.decodeUnknown(Schema.Record({ key: Schema.String, value: Schema.Unknown }));

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
const readText = (document: ConfigTranslateDocument): Either.Either<string, string> => {
  try {
    return Either.right(new TextDecoder("utf-8", { fatal: true }).decode(document.bytes));
  } catch (cause) {
    return Either.left(`${describe(document)} is not valid UTF-8 text: ${String(cause)}`);
  }
};

/**
 * Parse one bounded document into an authoring wire fragment. A rejection is a
 * message rather than a failure channel so one bad document becomes an
 * `unsupported` diagnostic instead of aborting the whole set.
 */
const parseDocument = (
  document: ConfigTranslateDocument,
): Effect.Effect<Either.Either<AuthoringFragmentWire, string>, never, never> => {
  if (!YAML_MEDIA_TYPES.has(document.mediaType)) {
    return Effect.succeed(
      Either.left(
        `${describe(document)} is not canonical v4 YAML (media type ${document.mediaType}); TypeScript Landofiles and includes stay opaque and are never executed.`,
      ),
    );
  }
  const text = readText(document);
  if (Either.isLeft(text)) return Effect.succeed(Either.left(text.left));
  return parseLandofile({ file: describe(document), content: text.right, cwd: "." }).pipe(
    Effect.flatMap((value) => decodeFragment(value, { onExcessProperty: "error" })),
    Effect.flatMap(encodeFragment),
    Effect.match({
      onSuccess: (wire): Either.Either<AuthoringFragmentWire, string> => Either.right(wire),
      onFailure: (cause): Either.Either<AuthoringFragmentWire, string> =>
        Either.left(`${describe(document)} is not valid canonical v4 authoring data: ${cause.message}`),
    }),
  );
};

interface DecodedDocument {
  readonly document: ConfigTranslateDocument;
  readonly layer: LandofileLayerId;
  readonly wire: AuthoringFragmentWire;
}

const detect = (
  input: ConfigTranslateDetectInput,
): Effect.Effect<ReadonlyArray<ConfigTranslateMatch>, ConfigTranslateError, never> =>
  Effect.gen(function* () {
    const candidates = input.documents.filter((document) => YAML_MEDIA_TYPES.has(document.mediaType));
    if (candidates.length === 0) return [];
    const matched: ConfigTranslateDocument[] = [];
    let marked = false;
    for (const document of candidates) {
      const parsed = yield* parseDocument(document);
      if (Either.isLeft(parsed)) return [];
      // `runtime: 4` is the one marker a Lando 3 document cannot carry, so it is
      // the sole basis for `exact`. Anything else that survives strict v4
      // authoring decoding is only `likely`.
      marked ||= typeof parsed.right === "object" && Reflect.get(parsed.right, "runtime") === 4;
      matched.push(document);
    }
    return [
      {
        translator: LANDO4_TRANSLATOR_ID,
        sourceIds: matched.map((document) => document.sourceId),
        confidence: marked ? "exact" : "likely",
        summary: SUMMARY,
      },
    ];
  });

const translate = (
  input: ConfigTranslateInput,
): Effect.Effect<ConfigTranslateResult, ConfigTranslateError, never> =>
  Effect.gen(function* () {
    if (input._tag === "recipe-request") {
      return yield* Effect.fail(
        translateError(
          "The lando4 translator decodes canonical v4 Landofile document sets, not recipe requests.",
          "Select the recipe translator for a recipe request.",
        ),
      );
    }
    yield* validateConfigTranslateInput(input);
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
      if (Either.isLeft(parsed)) {
        diagnostics.push(rootDiagnostic(document, "unsupported", parsed.left));
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
      decoded.push({ document, layer: document.layerId, wire: parsed.right });
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

    // Input order drives both arrays and every diagnostic is root-scoped, so the
    // document walk above already satisfies the canonical ordering contract.
    return { outputs, diagnostics, deletions: [] };
  });

const encode = (
  input: ConfigTranslateEncodeInput,
): Effect.Effect<ConfigTranslateEncodeResult, ConfigTranslateError, never> =>
  Effect.gen(function* () {
    // The context is the already-merged complete authoring tree. Validating it
    // is the contextual validation a fragment write requires; only the fragment
    // wire tree reaches the emitter, so lower layers are never flattened.
    const context = yield* decodeShape(input.context, { onExcessProperty: "error" }).pipe(
      Effect.mapError(asTranslateError("The lando4 encoder requires a complete authoring context:")),
    );
    const wire = yield* (
      input.fragment === undefined
        ? encodeShape(context)
        : decodeFragment(input.fragment, { onExcessProperty: "error" }).pipe(Effect.flatMap(encodeFragment))
    ).pipe(Effect.mapError(asTranslateError("The lando4 encoder received a non-authoring value:")));
    const record = yield* decodeRecord(wire).pipe(
      Effect.mapError(asTranslateError("The lando4 encoder requires a Landofile mapping at the root:")),
    );
    const emitted = emitLandofileYamlEither(record, { sortKeys: true });
    if (Either.isLeft(emitted)) {
      return yield* Effect.fail(translateError(emitted.left.message, undefined, emitted.left));
    }
    return { text: emitted.right, diagnostics: [] };
  });

/** The bundled `lando4` translator. */
export const lando4ConfigTranslator: ConfigTranslatorShape = {
  id: LANDO4_TRANSLATOR_ID,
  summary: SUMMARY,
  inputKinds: [LANDO4_TRANSLATOR_ID],
  detect,
  translate,
  encode,
};

export default lando4ConfigTranslator;
