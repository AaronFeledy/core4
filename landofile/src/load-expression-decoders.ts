import { LandofileExpressionEvalError } from "@lando/sdk/errors";
import type { ExpressionHelperOverride } from "@lando/sdk/expressions";
import type { FileRef } from "@lando/sdk/schema";

import type { LandofileFileSession } from "./load-expression-file.ts";

const isFileRef = (value: unknown): value is FileRef =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === "FileRef";

const requireRef = (args: ReadonlyArray<unknown>, decoder: string, sourcePath: string): FileRef => {
  const ref = args[0];
  if (isFileRef(ref)) return ref;
  throw new LandofileExpressionEvalError({
    message: `The ${decoder} decoder expects a FileRef.`,
    filePath: sourcePath,
    remediation: `Pipe load(path) into ${decoder}.`,
  });
};

const TEMPORAL_TAG = /^\[object Temporal\./;

const isTemporalLike = (value: unknown): value is { readonly toJSON: () => unknown } =>
  typeof value === "object" &&
  value !== null &&
  "toJSON" in value &&
  typeof value.toJSON === "function" &&
  TEMPORAL_TAG.test(Object.prototype.toString.call(value));

/** Bun 1.4 TOML date/time literals are Temporal objects; keep expression values JSON-like. */
const toJsonLike = (value: unknown): unknown => {
  if (isTemporalLike(value)) {
    const json = value.toJSON();
    return typeof json === "string" ? json : String(value);
  }
  if (Array.isArray(value)) return value.map(toJsonLike);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJsonLike(entry)]));
  }
  return value;
};

const decoderFailure = (decoder: string, sourcePath: string, cause: unknown): LandofileExpressionEvalError =>
  new LandofileExpressionEvalError({
    message:
      cause instanceof Error && cause.message.length > 0
        ? `Landofile ${decoder} decoder failed: ${cause.message}`
        : `Landofile ${decoder} decoder failed.`,
    filePath: sourcePath,
    remediation: `Fix the ${decoder} source file or use a different Landofile decoder.`,
    cause,
  });

const parseDecoderValue = (session: LandofileFileSession, decoder: string, parse: () => unknown): unknown => {
  try {
    return parse();
  } catch (cause) {
    if (cause instanceof LandofileExpressionEvalError) throw cause;
    throw decoderFailure(decoder, session.source.sourcePath, cause);
  }
};

const decode = (session: LandofileFileSession, ref: FileRef, decoder: string): unknown => {
  switch (decoder) {
    case "text":
      return session.text(ref);
    case "bytes":
      return session.bytes(ref);
    case "json": {
      const value: unknown = parseDecoderValue(session, decoder, () => JSON.parse(session.text(ref)));
      return value;
    }
    case "yaml":
    case "fromYaml":
      return parseDecoderValue(session, decoder, () => Bun.YAML.parse(session.text(ref)));
    case "fromToml":
      return toJsonLike(parseDecoderValue(session, decoder, () => Bun.TOML.parse(session.text(ref))));
    default:
      throw new LandofileExpressionEvalError({
        message: `Unsupported Landofile load decoder ${decoder}.`,
        filePath: session.source.sourcePath,
        remediation: "Use text, bytes, json, yaml, fromYaml, or fromToml.",
      });
  }
};

const inferredDecoder = (path: string): string => {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "yaml";
  if (path.endsWith(".toml")) return "fromToml";
  return "text";
};

export const makeLandofileLoadHelperOverrides = (
  session: LandofileFileSession,
): Readonly<Record<string, ExpressionHelperOverride>> => ({
  load: (args) => {
    const authoredPath = String(args[0]);
    const ref = session.load(authoredPath);
    return args[1] === undefined ? ref : decode(session, ref, String(args[1]));
  },
  import: (args) => {
    const authoredPath = String(args[0]);
    const ref = session.load(authoredPath);
    const decoder = args[1] === undefined ? inferredDecoder(authoredPath) : String(args[1]);
    return session.import(authoredPath, ref, decode(session, ref, decoder));
  },
  text: (args) => session.text(requireRef(args, "text", session.source.sourcePath)),
  bytes: (args) => session.bytes(requireRef(args, "bytes", session.source.sourcePath)),
  json: (args) => decode(session, requireRef(args, "json", session.source.sourcePath), "json"),
  yaml: (args) => decode(session, requireRef(args, "yaml", session.source.sourcePath), "yaml"),
  fromYaml: (args) => decode(session, requireRef(args, "fromYaml", session.source.sourcePath), "fromYaml"),
  fromToml: (args) => decode(session, requireRef(args, "fromToml", session.source.sourcePath), "fromToml"),
});

export const decodeImplicitFileRef = (session: LandofileFileSession, value: unknown): unknown =>
  isFileRef(value) ? decode(session, value, inferredDecoder(value.path)) : value;
