import { emitLandofileYamlEither } from "@lando/sdk/landofile";
import { Predicate, Result } from "effect";
import { type UnsupportedEdit, unsupported } from "./yaml-locate";

export const authoredTreesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => authoredTreesEqual(value, right[index]))
    );
  }
  if (!Predicate.isObject(left) || !Predicate.isObject(right)) return false;
  const keys = Reflect.ownKeys(left);
  const otherKeys = Reflect.ownKeys(right);
  return (
    keys.length === otherKeys.length &&
    keys.every(
      (key) => otherKeys.includes(key) && authoredTreesEqual(Reflect.get(left, key), Reflect.get(right, key)),
    )
  );
};

export const canonicalRewrite = (
  source: string,
  original: Record<string, unknown>,
  next: unknown,
): Result.Result<string, UnsupportedEdit> => {
  const before = emitLandofileYamlEither(original);
  const blank = source.trim() === "";
  if (!blank && (Result.isFailure(before) || before.success !== source))
    return unsupported("The original document is not canonical; a rewrite would lose authored formatting.");
  if (!Predicate.isObject(next) || Array.isArray(next))
    return unsupported("The document root must remain a mapping.");
  const emitted = emitLandofileYamlEither(next);
  return Result.isFailure(emitted) ? unsupported(emitted.failure.message) : Result.succeed(emitted.success);
};
