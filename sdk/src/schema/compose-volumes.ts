import { SchemaIssue, SchemaTransformation } from "effect";
import { Effect } from "effect";
import { Schema } from "effect";

const DRIVE_LETTER_PATH = /^[A-Za-z]:[\\/]/;

const ComposeVolumeType = Schema.Literals(["bind", "volume", "tmpfs"]);
const Forbidden = Schema.optionalKey(Schema.Never);

const ComposeVolumeTmpfs = Schema.Struct({
  size: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  mode: Schema.optionalKey(Schema.Number),
});

const ComposeVolumeOptions = Schema.Struct({
  subpath: Schema.optionalKey(Schema.String),
  nocopy: Forbidden,
  labels: Forbidden,
});

const ComposeVolumeBind = Schema.Struct({
  create_host_path: Schema.optionalKey(Schema.Boolean),
  propagation: Forbidden,
  recursive: Forbidden,
  selinux: Forbidden,
});

const ComposeVolumeLongInput = Schema.Struct({
  type: Schema.optionalKey(ComposeVolumeType),
  source: Schema.optionalKey(Schema.String),
  target: Schema.String,
  read_only: Schema.optionalKey(Schema.Boolean),
  volume: Schema.optionalKey(ComposeVolumeOptions),
  bind: Schema.optionalKey(ComposeVolumeBind),
  tmpfs: Schema.optionalKey(ComposeVolumeTmpfs),
  readOnly: Forbidden,
  subpath: Forbidden,
  createHostPath: Forbidden,
  consistency: Forbidden,
  image: Forbidden,
});

const ComposeVolumeEntry = Schema.Struct({
  type: ComposeVolumeType,
  source: Schema.optionalKey(Schema.String),
  target: Schema.String,
  readOnly: Schema.Boolean,
  subpath: Schema.optionalKey(Schema.String),
  createHostPath: Schema.optionalKey(Schema.Boolean),
  tmpfs: Schema.optionalKey(ComposeVolumeTmpfs),
});
export type ComposeVolumeEntry = typeof ComposeVolumeEntry.Type;

const ComposeVolumeCanonicalInput = ComposeVolumeEntry.pipe(Schema.fieldsAssign({
    read_only: Forbidden,
    volume: Forbidden,
    bind: Forbidden,
    consistency: Forbidden,
    image: Forbidden,
  }));

const isPathLikeSource = (source: string): boolean =>
  source.startsWith(".") ||
  source.startsWith("/") ||
  source.startsWith("~") ||
  source.startsWith("\\") ||
  DRIVE_LETTER_PATH.test(source);

const rejectedModeMatrixKey = (token: string): string | undefined => {
  switch (token) {
    case "nocopy":
      return "volumes.volume.nocopy";
    case "z":
    case "Z":
      return "volumes.bind.selinux";
    case "rprivate":
    case "private":
    case "rshared":
    case "shared":
    case "rslave":
    case "slave":
      return "volumes.bind.propagation";
    default:
      return undefined;
  }
};

const splitVolumeSpec = (spec: string): readonly string[] => {
  if (!DRIVE_LETTER_PATH.test(spec)) return spec.split(":");
  const [path = "", ...rest] = spec.slice(2).split(":");
  return [`${spec.slice(0, 2)}${path}`, ...rest];
};

const shortVolumeFailure = (spec: string): string | undefined => {
  const segments = splitVolumeSpec(spec);
  if (spec.length <= 2 || segments.length === 1) return undefined;
  if (segments.length > 3) {
    return `Compose volume short syntax must contain source, target, and at most one mode segment: ${spec}`;
  }

  const [source = "", target = "", mode = ""] = segments;
  if (source.length === 0 || target.length === 0) {
    return `Compose volume short syntax requires non-empty source and target segments: ${spec}`;
  }

  for (const token of mode.split(",")) {
    const matrixKey = rejectedModeMatrixKey(token);
    if (matrixKey !== undefined) {
      return `Compose volume mode "${token}" is unsupported; remove the rejected matrix key ${matrixKey}.`;
    }
  }
  return undefined;
};

export const parseShortVolume = (spec: string): ComposeVolumeEntry => {
  const failure = shortVolumeFailure(spec);
  if (failure !== undefined) throw new SchemaIssue.InvalidValue({ message: failure }, spec);

  const segments = splitVolumeSpec(spec);
  if (spec.length <= 2 || segments.length === 1) {
    return { type: "volume", target: spec, readOnly: false };
  }

  const [source = "", target = "", mode = ""] = segments;
  let readOnly = false;
  for (const token of mode.split(",")) {
    if (token === "ro") readOnly = true;
    if (token === "rw") readOnly = false;
  }

  if (isPathLikeSource(source)) {
    return { type: "bind", source, target, readOnly, createHostPath: true };
  }
  return { type: "volume", source, target, readOnly };
};

const decodeLongVolume = (
  input: typeof ComposeVolumeLongInput.Type | typeof ComposeVolumeCanonicalInput.Type,
): ComposeVolumeEntry => {
  const type =
    input.type ?? (input.source !== undefined && isPathLikeSource(input.source) ? "bind" : "volume");
  const createHostPath = input.createHostPath ?? input.bind?.create_host_path;
  const subpath = input.subpath ?? input.volume?.subpath;
  return {
    type,
    ...(input.source === undefined ? {} : { source: input.source }),
    target: input.target,
    readOnly: input.readOnly ?? input.read_only ?? false,
    ...(subpath === undefined ? {} : { subpath }),
    ...(type === "bind"
      ? { createHostPath: createHostPath ?? true }
      : createHostPath === undefined
        ? {}
        : { createHostPath }),
    ...(input.tmpfs === undefined ? {} : { tmpfs: input.tmpfs }),
  };
};

const longVolumeFailure = (
  input: typeof ComposeVolumeLongInput.Type | typeof ComposeVolumeCanonicalInput.Type,
): string | undefined => {
  const type =
    input.type ?? (input.source !== undefined && isPathLikeSource(input.source) ? "bind" : "volume");
  switch (type) {
    case "bind":
      if (input.source === undefined) return 'Compose volume type "bind" requires source.';
      if (input.volume !== undefined) return 'Compose volume type "bind" must not define volume options.';
      if (input.subpath !== undefined) return 'Compose volume type "bind" must not define volume subpath.';
      if (input.tmpfs !== undefined) return 'Compose volume type "bind" must not define tmpfs options.';
      return undefined;
    case "volume":
      if (input.type === "volume" && input.source !== undefined && isPathLikeSource(input.source)) {
        return 'Compose volume type "volume" must not define a path-like source.';
      }
      if (input.bind !== undefined) return 'Compose volume type "volume" must not define bind options.';
      if (input.createHostPath !== undefined)
        return 'Compose volume type "volume" must not define bind path creation.';
      if (input.tmpfs !== undefined) return 'Compose volume type "volume" must not define tmpfs options.';
      return undefined;
    case "tmpfs":
      if (input.source !== undefined) return 'Compose volume type "tmpfs" must not define source.';
      if (input.bind !== undefined) return 'Compose volume type "tmpfs" must not define bind options.';
      if (input.createHostPath !== undefined)
        return 'Compose volume type "tmpfs" must not define bind path creation.';
      if (input.volume !== undefined) return 'Compose volume type "tmpfs" must not define volume options.';
      if (input.subpath !== undefined) return 'Compose volume type "tmpfs" must not define volume subpath.';
      return undefined;
  }
};

const encodeLongVolume = (entry: ComposeVolumeEntry): typeof ComposeVolumeLongInput.Type => ({
  type: entry.type,
  ...(entry.source === undefined ? {} : { source: entry.source }),
  target: entry.target,
  read_only: entry.readOnly,
  ...(entry.subpath === undefined ? {} : { volume: { subpath: entry.subpath } }),
  ...(entry.type === "bind"
    ? { bind: { create_host_path: entry.createHostPath ?? true } }
    : entry.createHostPath === undefined
      ? {}
      : { bind: { create_host_path: entry.createHostPath } }),
  ...(entry.tmpfs === undefined ? {} : { tmpfs: entry.tmpfs }),
});

export const ComposeVolumesField = Schema.Array(
  Schema.Union([Schema.String, ComposeVolumeLongInput, ComposeVolumeCanonicalInput]).pipe(Schema.decodeTo(ComposeVolumeEntry, SchemaTransformation.transformEffect({ decode: (input, _options) => { 
        if (typeof input === "string") {
          const failure = shortVolumeFailure(input);
          return failure === undefined
            ? Effect.succeed(parseShortVolume(input))
            : Effect.fail(new SchemaIssue.InvalidValue({ message: failure }, input));
        }
        const failure = longVolumeFailure(input);
        if (failure !== undefined) return Effect.fail(new SchemaIssue.InvalidValue({ message: failure }, input));
        return Effect.succeed(decodeLongVolume(input));
       }, encode: (entry, _options) => { 
        const failure = longVolumeFailure(entry);
        return failure === undefined
          ? Effect.succeed(encodeLongVolume(entry))
          : Effect.fail(new SchemaIssue.InvalidValue({ message: failure }, entry));
       } }))),
);
