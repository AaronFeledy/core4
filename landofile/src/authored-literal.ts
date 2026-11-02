import { isLandofileOverride, isLandofileReset, isPlainRecord, valueOriginAt } from "@lando/sdk/landofile";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { isSecretEnvName, isSecretStructuralName } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
import { prepareOverlay } from "./pipeline/prepare.ts";
import { type SourceDocument, getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
import { detectTemplateDirective } from "./template-render.ts";

const sourceEligibility = new WeakMap<SourceDocument, boolean>();

const eligibleSource = (source: SourceDocument): boolean => {
  const cached = sourceEligibility.get(source);
  if (cached !== undefined) return cached;
  const eligible =
    source.form === "yaml" &&
    ["base", "dist", "upstream", "canonical"].includes(source.layer) &&
    detectTemplateDirective(source.content) === undefined;
  sourceEligibility.set(source, eligible);
  return eligible;
};

export const authoredSourceDocument = Effect.fnUntraced(function* (source: SourceDocument) {
  const prepared = yield* prepareOverlay(source.document, { file: source.file, layer: source.layer });
  return rememberSourceDocuments(rememberOrigins(prepared.value, prepared.origins), [source]);
});

const at = (document: unknown, path: ValidationIssuePath): unknown => {
  let value = document;
  for (const key of path) {
    if (isLandofileOverride(value)) value = value.value;
    if (!isPlainRecord(value) && !Array.isArray(value)) return undefined;
    value = Reflect.get(value, key);
  }
  return isLandofileOverride(value) ? value.value : value;
};

/** Positive proof for one occurrence, never a search for matching bytes elsewhere. */
export const authoredLiteralAt = (document: object, path: ValidationIssuePath): string | undefined => {
  const origins = getOrigins(document);
  if (origins === undefined) return undefined;
  const documents = getSourceDocuments(document);
  let cursor = origins;
  for (const key of path) {
    let child = cursor.children.get(key);
    if (child === undefined && typeof key === "string") {
      // Schema decoding turns environment lists into maps; retain the winning list occurrence.
      for (const [index, entry] of cursor.children) {
        if (typeof index !== "number") continue;
        const source = documents.find(
          ({ file, layer }) => file === entry.source.file && layer === entry.source.layer,
        );
        const raw = at(source?.document, entry.source.path);
        if (typeof raw === "string" && raw.startsWith(`${key}=`)) child = entry;
      }
    }
    if (child === undefined || child.deleted) return undefined;
    cursor = child;
  }
  const origin = valueOriginAt(cursor, []).source;
  const source = documents.find(({ file, layer }) => file === origin.file && layer === origin.layer);
  if (source === undefined || !eligibleSource(source)) return undefined;
  const raw = at(source.document, origin.path);
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return undefined;
  let literal = String(raw);
  if (literal.includes("{{") || literal.includes("${")) return undefined;
  const key = path.at(-1);
  if (typeof origin.path.at(-1) === "number" && typeof key === "string" && literal.startsWith(`${key}=`)) {
    literal = literal.slice(key.length + 1);
  }
  const final = at(document, path);
  return (typeof final === "string" || typeof final === "number" || typeof final === "boolean") &&
    String(final) === literal
    ? literal
    : undefined;
};

const isEnvMap = (path: ValidationIssuePath): boolean =>
  (path.length === 1 && (path[0] === "appEnv" || path[0] === "appLabels")) ||
  (path.length === 2 && path[0] === "toolingDefaults" && path[1] === "env") ||
  (path.length === 3 && path[0] === "tooling" && path[2] === "env") ||
  (path.length === 5 && path[0] === "tooling" && path[2] === "cmds" && path[4] === "env") ||
  (path.length === 4 && (path[0] === "events" || path[0] === "hostEvents") && path[3] === "env") ||
  (path[0] === "services" &&
    ((path.length === 3 && (path[2] === "environment" || path[2] === "labels")) ||
      (path.length === 5 && path[2] === "extensions" && path[3] === "compose" && path[4] === "labels")));

export function* sensitiveLandofileOccurrences(
  document: unknown,
  path: ValidationIssuePath = [],
): Generator<{ readonly path: ValidationIssuePath; readonly value: string }> {
  if (isLandofileReset(document)) return;
  if (isLandofileOverride(document)) {
    yield* sensitiveLandofileOccurrences(document.value, path);
    return;
  }
  if (Array.isArray(document)) {
    for (const [index, entry] of document.entries()) {
      if (isEnvMap(path) && typeof entry === "string") {
        const equals = entry.indexOf("=");
        if (equals >= 0 && isSecretEnvName(entry.slice(0, equals)))
          yield { path: [...path, index], value: entry.slice(equals + 1) };
      } else yield* sensitiveLandofileOccurrences(entry, [...path, index]);
    }
    return;
  }
  if (isPlainRecord(document)) {
    for (const [key, value] of Object.entries(document))
      yield* sensitiveLandofileOccurrences(value, [...path, key]);
    return;
  }
  if (typeof document !== "string" && typeof document !== "number" && typeof document !== "boolean") return;
  const key = path.at(-1);
  if (typeof key !== "string") return;
  const sensitive = isEnvMap(path.slice(0, -1)) ? isSecretEnvName(key) : isSecretStructuralName(key);
  if (sensitive) yield { path, value: String(document) };
}

export const committedSensitiveLiterals = (document: object): ReadonlySet<string> => {
  const values = new Set<string>();
  for (const { path, value } of sensitiveLandofileOccurrences(document)) {
    if (
      !(isEnvMap(path.slice(0, -1)) && !["appEnv", "appLabels", "hostEvents"].includes(String(path[0]))) &&
      !(
        path[0] === "services" &&
        ((path.length === 4 && path[2] === "creds") || (path.length === 3 && path[2] === "password"))
      )
    )
      continue;
    const literal = authoredLiteralAt(document, path);
    const key = path.at(-1);
    if (literal === value || (typeof key === "number" && literal?.endsWith(`=${value}`))) values.add(value);
  }
  return values;
};
