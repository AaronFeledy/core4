import { Effect, Schema } from "effect";
import { type LandofileParseError, LandofileValidationError } from "../errors/landofile.ts";
import type { LandofileDecodedOverlay } from "../schema/landofile-overlay.ts";
import { LandofileShape, SERVICE_CONFIG_ALIASES } from "../schema/landofile.ts";
import { validationIssuesFromCause } from "../schema/validation-issue.ts";
import { type DirectivePath, canonicalDirectivePath, directivePathProblem } from "./directive-paths.ts";
import { isLandofileOverride, isMergeDirective, override, reset } from "./merge-directives.ts";
import { isPlainRecord } from "./record.ts";

const REMEDIATION =
  "Apply !reset to the containing mapping key, or !override the containing value with a complete valid replacement.";
const ABSENT = Symbol("absent");

/** Strictly decodes the directive-free tree; callers may substitute their own diagnostics. */
export type LandofileLayerValidator = (
  plain: unknown,
) => Effect.Effect<typeof LandofileShape.Type, LandofileValidationError | LandofileParseError>;

const strictValidator =
  (file: string): LandofileLayerValidator =>
  (plain) =>
    Schema.decodeUnknownEffect(LandofileShape)(plain, { onExcessProperty: "error", errors: "all" }).pipe(
      Effect.mapError(
        (cause) =>
          new LandofileValidationError({
            file,
            message: "Invalid Landofile layer.",
            issues: validationIssuesFromCause(cause),
          }),
      ),
    );

export const decodeLandofileLayer: (
  file: string,
  input: unknown,
  validate?: LandofileLayerValidator,
) => Effect.Effect<LandofileDecodedOverlay, LandofileValidationError | LandofileParseError> =
  Effect.fnUntraced(function* (
    file: string,
    input: unknown,
    validate: LandofileLayerValidator = strictValidator(file),
  ): Effect.fn.Return<LandofileDecodedOverlay, LandofileValidationError | LandofileParseError> {
    const directives: { readonly path: DirectivePath; readonly kind: "override" | "reset" }[] = [];
    const fail = (path: DirectivePath, reason: string): never => {
      throw new LandofileValidationError({
        file,
        message: `${reason} ${REMEDIATION}`,
        issues: [{ path, message: reason, suggestion: REMEDIATION }],
      });
    };
    const extract = (value: unknown, path: DirectivePath): unknown => {
      if (isMergeDirective(value)) {
        if (path.length === 0 || typeof path.at(-1) === "number")
          fail(path, "Directives require a mapping member.");
        const problem = directivePathProblem(input, path);
        if (problem !== undefined) fail(path, problem);
        const keys = Reflect.ownKeys(value);
        if (keys.length !== (isLandofileOverride(value) ? 2 : 1)) fail(path, "Malformed directive wrapper.");
        directives.push({
          path: canonicalDirectivePath(path),
          kind: isLandofileOverride(value) ? "override" : "reset",
        });
        if (!isLandofileOverride(value)) return ABSENT;
        if (isMergeDirective(value.value)) fail(path, "A directive cannot wrap another directive.");
        return extract(value.value, path);
      }
      if (Array.isArray(value)) return value.map((entry, index) => extract(entry, [...path, index]));
      if (!isPlainRecord(value)) return value;
      const entries = Object.entries(value).filter(
        ([key]) =>
          !(
            path.length === 2 &&
            path[0] === "services" &&
            SERVICE_CONFIG_ALIASES.some(
              ([alias, canonical]) => key === alias && Object.hasOwn(value, canonical),
            )
          ),
      );
      return Object.fromEntries(
        entries.flatMap(([key, entry]) => {
          const result = extract(entry, [...path, key]);
          return result === ABSENT ? [] : [[key, result]];
        }),
      );
    };
    const stripped = yield* Effect.try({
      try: () => extract(input, []),
      catch: (cause) =>
        cause instanceof LandofileValidationError
          ? cause
          : new LandofileValidationError({
              file,
              message: `Invalid directive tree. ${REMEDIATION}`,
              issues: validationIssuesFromCause(cause),
            }),
    });
    // A directive may have stripped a required member, so failures name the containing-value remediation.
    const decoded = yield* validate(stripped).pipe(
      Effect.mapError((error) =>
        directives.length === 0 || error._tag !== "LandofileValidationError"
          ? error
          : new LandofileValidationError({
              file: error.file,
              issues: error.issues,
              message: `${error.message} ${REMEDIATION}`,
            }),
      ),
    );
    const reinsert = (value: unknown, path: DirectivePath, kind: "override" | "reset"): unknown => {
      const [head, ...tail] = path;
      if (head === undefined) return kind === "override" ? override(value) : reset();
      if (typeof head === "number") {
        if (!Array.isArray(value) || head >= value.length)
          return fail(path, "Directive path was reshaped during decoding.");
        return value.map((entry, index) => (index === head ? reinsert(entry, tail, kind) : entry));
      }
      if (!isPlainRecord(value)) return fail(path, "Directive parent was reshaped during decoding.");
      if (tail.length > 0 && !Object.hasOwn(value, head))
        fail(path, "Directive parent disappeared during decoding.");
      return { ...value, [head]: reinsert(value[head], tail, kind) };
    };
    return yield* Effect.try({
      try: () => {
        let result: unknown = decoded;
        for (const directive of [...directives].reverse())
          result = reinsert(result, directive.path, directive.kind);
        return result as LandofileDecodedOverlay;
      },
      catch: (cause) =>
        cause instanceof LandofileValidationError
          ? cause
          : new LandofileValidationError({
              file,
              message: `Cannot restore directive paths. ${REMEDIATION}`,
              issues: validationIssuesFromCause(cause),
            }),
    });
  });
