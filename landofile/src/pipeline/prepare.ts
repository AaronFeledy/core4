import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ValueOrigins,
  type ValueWithOrigins,
  directivePathProblem,
  isLandofileOverride,
  isLandofileReset,
  isMergeDirective,
  isPlainRecord,
  override,
} from "@lando/sdk/landofile";
import { SERVICE_CONFIG_ALIASES, type ValidationIssue } from "@lando/sdk/schema";
import { Effect } from "effect";

export type AuthoredOrigin = NonNullable<ValidationIssue["source"]>;
export type PreparedOverlay = ValueWithOrigins<AuthoredOrigin> & { readonly value: Record<string, unknown> };
const emptyChildren: ReadonlyMap<string | number, ValueOrigins<AuthoredOrigin>> = new Map();
interface AuthoredCursor {
  readonly value: unknown;
  readonly path: readonly (string | number)[];
}

export const prepareOverlay = Effect.fnUntraced(function* (
  value: unknown,
  source: Omit<AuthoredOrigin, "path">,
  authored: unknown = value,
): Effect.fn.Return<PreparedOverlay, LandofileValidationError> {
  const fail = (path: readonly (string | number)[], message: string): never => {
    const remediation = "Correct the authored value or override its containing mapping.";
    throw new LandofileValidationError({
      file: source.file,
      message,
      remediation,
      issues: [{ path, message, suggestion: remediation, source: { ...source, path } }],
    });
  };
  return yield* Effect.try({
    try: () => {
      let nodes = 0;
      const childCursor = (cursor: AuthoredCursor, key: string | number): AuthoredCursor => {
        const plain = isLandofileOverride(cursor.value) ? cursor.value.value : cursor.value;
        if (Array.isArray(plain) && typeof key === "number" && key < plain.length)
          return { value: plain[key], path: [...cursor.path, key] };
        if (isPlainRecord(plain) && Object.hasOwn(plain, key))
          return { value: plain[String(key)], path: [...cursor.path, key] };
        return cursor;
      };
      const visit = (
        input: unknown,
        path: readonly (string | number)[],
        cursor: AuthoredCursor,
      ): ValueWithOrigins<AuthoredOrigin> => {
        if (++nodes > 100000 || path.length > 64) fail(cursor.path, "Landofile exceeds the document budget.");
        const origins: ValueOrigins<AuthoredOrigin> = {
          source: { ...source, path: cursor.path },
          deleted: isLandofileReset(input),
          children: emptyChildren,
        };
        if (isMergeDirective(input)) {
          if (path.length === 0 || typeof path.at(-1) === "number")
            fail(cursor.path, "Directives require a mapping member.");
          const problem = directivePathProblem(value, path);
          if (problem !== undefined) fail(cursor.path, problem);
          if (Reflect.ownKeys(input).length !== (isLandofileOverride(input) ? 2 : 1))
            fail(cursor.path, "Malformed directive wrapper.");
          if (!isLandofileOverride(input)) return { value: input, origins };
          if (isMergeDirective(input.value)) fail(cursor.path, "A directive cannot wrap another directive.");
          const payload = visit(input.value, path, cursor);
          return { value: override(payload.value), origins: payload.origins };
        }
        if (Array.isArray(input)) {
          const children = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
          const values = input.map((entry, index) => {
            const child = visit(entry, [...path, index], childCursor(cursor, index));
            children.set(index, child.origins);
            return child.value;
          });
          return { value: values, origins: { ...origins, children } };
        }
        if (isPlainRecord(input)) {
          const children = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
          const entries = Object.entries(input).flatMap(([key, entry]) => {
            const alias =
              path.length === 2 && path[0] === "services"
                ? SERVICE_CONFIG_ALIASES.find(([name]) => name === key)
                : undefined;
            if (alias !== undefined && Object.hasOwn(input, alias[1])) return [];
            const child = visit(entry, [...path, key], childCursor(cursor, key));
            const canonical = alias?.[1] ?? key;
            children.set(canonical, child.origins);
            return [[canonical, child.value]];
          });
          return { value: Object.fromEntries(entries), origins: { ...origins, children } };
        }
        if (
          input === null ||
          input === undefined ||
          typeof input === "string" ||
          typeof input === "boolean" ||
          (typeof input === "number" && Number.isFinite(input))
        )
          return { value: input, origins };
        return fail(cursor.path, "Landofile values must be finite plain data.");
      };
      if (!isPlainRecord(value) || isMergeDirective(value)) fail([], "Landofile must be a mapping.");
      const prepared = visit(value, [], { value: authored, path: [] });
      if (!isPlainRecord(prepared.value)) return fail([], "Landofile must be a mapping.");
      return { value: prepared.value, origins: prepared.origins };
    },
    catch: (cause) =>
      cause instanceof LandofileValidationError
        ? cause
        : new LandofileValidationError({
            file: source.file,
            message: "Landofile contains an invalid or cyclic document.",
            remediation: "Use a bounded plain-data Landofile mapping.",
            issues: [],
          }),
  });
});
