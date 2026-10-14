import { ConfigTranslateError } from "@lando/sdk/errors";
import { decodeLandofileLayer, isPlainRecord, mergeLandofiles, override, reset } from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { equal } from "./layer-delta-values.ts";
import type { DesiredPrefix } from "./layer-delta.ts";

type Path = ReadonlyArray<string | number>;
type EmittedLayer = {
  readonly layer: DesiredPrefix["layer"];
  readonly fragment: Readonly<Record<string, unknown>>;
};

const differencePath = (left: unknown, right: unknown, path: Path = []): Path | undefined => {
  if (equal(left, right, path)) return undefined;
  if (!isPlainRecord(left) || !isPlainRecord(right)) return path;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (Object.hasOwn(left, key) !== Object.hasOwn(right, key)) return [...path, key];
    const child = differencePath(left[key], right[key], [...path, key]);
    if (child !== undefined) return child;
  }
  return undefined;
};

const valueAt = (value: unknown, path: Path): unknown => {
  let current = value;
  for (const segment of path) current = isPlainRecord(current) ? current[String(segment)] : undefined;
  return current;
};

const replaceAt = (value: unknown, path: Path, replacement: unknown): Record<string, unknown> => {
  const [head, ...tail] = path;
  const parent = isPlainRecord(value) ? value : {};
  if (typeof head !== "string") return parent;
  return { ...parent, [head]: tail.length === 0 ? replacement : replaceAt(parent[head], tail, replacement) };
};

export const replayDecodedDeltas = Effect.fnUntraced(function* (
  prefixes: ReadonlyArray<DesiredPrefix>,
  emitted: ReadonlyArray<EmittedLayer>,
): Effect.fn.Return<ReadonlyArray<EmittedLayer>, ConfigTranslateError> {
  let accumulated: Record<string, unknown> = {};
  const result: EmittedLayer[] = [];
  for (const [index, prefix] of prefixes.entries()) {
    let candidate = emitted[index]?.fragment ?? {};
    const expectedOverlay = yield* Effect.result(decodeLandofileLayer(prefix.layer, prefix.desired));
    // A prefix that is not a loadable layer on its own (for example partial
    // credentials completed by a type default) has no decoded oracle; the raw
    // replay in planLayerDeltas already proved the emitted fragment for it.
    if (Result.isFailure(expectedOverlay)) {
      const decoded = yield* Effect.result(decodeLandofileLayer(prefix.layer, candidate));
      accumulated = mergeLandofiles([accumulated, Result.isSuccess(decoded) ? decoded.success : candidate]);
      result.push({ layer: prefix.layer, fragment: candidate });
      continue;
    }
    const expected = mergeLandofiles([expectedOverlay.success]);
    const replaced = new Set<string>();
    for (;;) {
      const decoded = yield* Effect.result(decodeLandofileLayer(prefix.layer, candidate));
      if (Result.isSuccess(decoded)) {
        const merged = mergeLandofiles([accumulated, decoded.success]);
        if (equal(merged, expected)) {
          accumulated = merged;
          result.push({ layer: prefix.layer, fragment: candidate });
          break;
        }
      }
      let path = Result.isFailure(decoded)
        ? decoded.failure._tag === "LandofileValidationError"
          ? (decoded.failure.issues[0]?.path.slice(0, -1) ?? [])
          : []
        : (differencePath(mergeLandofiles([accumulated, decoded.success]), expected) ?? []);
      const arrayIndex = path.findIndex((segment) => typeof segment === "number");
      if (arrayIndex >= 0) path = path.slice(0, arrayIndex);
      while (path.length > 0 && replaced.has(JSON.stringify(path))) path = path.slice(0, -1);
      if (path.length === 0)
        return yield* Effect.fail(
          new ConfigTranslateError({
            message: `Cannot express the decoded ${prefix.layer} prefix as a native Landofile layer.`,
            remediation: "Replace the containing configuration with a complete valid Landofile value.",
          }),
        );
      replaced.add(JSON.stringify(path));
      const desired = valueAt(prefix.desired, path);
      candidate = replaceAt(candidate, path, desired === undefined ? reset() : override(desired));
    }
  }
  return result;
});
