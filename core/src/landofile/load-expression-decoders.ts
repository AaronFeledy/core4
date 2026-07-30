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

const decode = (session: LandofileFileSession, ref: FileRef, decoder: string): unknown => {
  switch (decoder) {
    case "text":
      return session.text(ref);
    case "bytes":
      return session.bytes(ref);
    case "json": {
      const value: unknown = JSON.parse(session.text(ref));
      return value;
    }
    case "yaml":
    case "fromYaml":
      return Bun.YAML.parse(session.text(ref));
    case "fromToml":
      return Bun.TOML.parse(session.text(ref));
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
