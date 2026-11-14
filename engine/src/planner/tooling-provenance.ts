import { getLandofileValueSource } from "@lando/landofile/validation";
import { isPlainRecord } from "@lando/sdk/landofile";
import { ValidationIssuePath, ValidationIssueSource } from "@lando/sdk/schema";
import { Schema } from "effect";
import {
  type ToolingComposition,
  compileEffectiveTooling,
  connectionClientOwners,
  toolingBeforeDefaults,
  toolingContributors,
} from "./tooling-composition.ts";

export const ToolingOrigin = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Known"), source: ValidationIssueSource }),
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
]);
export type ToolingOrigin = typeof ToolingOrigin.Type;
export const UNKNOWN_TOOLING_ORIGIN: ToolingOrigin = { _tag: "Unknown" };

export const ToolingTaskProvenance = Schema.Struct({
  origin: ToolingOrigin,
  overrides: Schema.Array(Schema.Struct({ path: ValidationIssuePath, origin: ToolingOrigin })),
  serviceTypeId: Schema.optionalKey(Schema.String),
});
export type ToolingTaskProvenance = typeof ToolingTaskProvenance.Type;
export const ToolingProvenance = Schema.Record(Schema.String, ToolingTaskProvenance);
export type ToolingProvenance = typeof ToolingProvenance.Type;

/** Capture the winning physical locations once, while composition still has authored origins. */
export const resolveEffectiveTooling = (input: ToolingComposition) => {
  const { landofile } = input;
  const beforeDefaults = toolingBeforeDefaults(input);
  const tasks = compileEffectiveTooling(input);
  const contributors = toolingContributors(input.services);
  const originAt = (path: ValidationIssuePath): ToolingOrigin => {
    const source = getLandofileValueSource(landofile, path);
    return source === undefined ? UNKNOWN_TOOLING_ORIGIN : { _tag: "Known", source };
  };
  const provenance: Record<string, ToolingTaskProvenance> = {};
  for (const [name, task] of Object.entries(tasks)) {
    const authored = Object.hasOwn(landofile.tooling ?? {}, name);
    const contributor = authored ? undefined : contributors.get(name);
    const origin =
      contributor === undefined
        ? originAt(["tooling", name])
        : originAt(["services", contributor.name, "type"]);
    const overrides: Array<{ readonly path: ValidationIssuePath; readonly origin: ToolingOrigin }> = [];
    const winner = beforeDefaults[name];
    const visit = (value: unknown, path: ValidationIssuePath, parent: ToolingOrigin): void => {
      const [field, member] = path;
      const inherited =
        ((field === "env" || field === "vars") &&
          member === undefined &&
          winner?.[field] === undefined &&
          landofile.toolingDefaults?.[field] !== undefined) ||
        ((field === "env" || field === "vars") &&
          typeof member === "string" &&
          !Object.hasOwn(winner?.[field] ?? {}, member) &&
          Object.hasOwn(landofile.toolingDefaults?.[field] ?? {}, member)) ||
        ((field === "service" || field === "dir") &&
          winner?.[field] === undefined &&
          landofile.toolingDefaults?.[field] !== undefined);
      const location = inherited
        ? originAt(["toolingDefaults", ...path])
        : authored
          ? originAt(["tooling", name, ...path])
          : origin;
      if (JSON.stringify(location) !== JSON.stringify(parent)) overrides.push({ path, origin: location });
      if (Array.isArray(value))
        value.forEach((child, index) => {
          visit(child, [...path, index], location);
        });
      else if (isPlainRecord(value)) {
        for (const [key, child] of Object.entries(value)) visit(child, [...path, key], location);
      }
    };
    for (const [key, value] of Object.entries(task)) visit(value, [key], origin);
    provenance[name] = {
      origin,
      overrides,
      ...(contributor?.serviceTypeId === undefined ? {} : { serviceTypeId: contributor.serviceTypeId }),
    };
  }
  return { tasks, beforeDefaults, provenance, connectionClients: connectionClientOwners(input) };
};
export type EffectiveToolingResolution = ReturnType<typeof resolveEffectiveTooling>;

/** Longest effective relative-path prefix wins, including explicit Unknown overrides. */
export const toolingOriginAt = (
  provenance: ToolingProvenance,
  name: string,
  relativePath: ValidationIssuePath,
): ToolingOrigin => {
  const task = provenance[name];
  let origin = task?.origin ?? UNKNOWN_TOOLING_ORIGIN;
  let length = -1;
  for (const entry of task?.overrides ?? []) {
    if (
      entry.path.length > length &&
      entry.path.length <= relativePath.length &&
      entry.path.every((part, index) => relativePath[index] === part)
    ) {
      origin = entry.origin;
      length = entry.path.length;
    }
  }
  return origin;
};

export const toolingIssueSource = (
  provenance: ToolingProvenance,
  name: string,
  relativePath: ValidationIssuePath,
): ValidationIssueSource | undefined => {
  const origin = toolingOriginAt(provenance, name, relativePath);
  switch (origin._tag) {
    case "Known":
      return origin.source;
    case "Unknown":
      return undefined;
    default:
      return origin satisfies never;
  }
};

/** Related paths use exactly the same resolver as the primary diagnostic location. */
export const toolingIssueLocations = (
  provenance: ToolingProvenance,
  name: string,
  relativePaths: readonly ValidationIssuePath[],
) =>
  relativePaths.map((relativePath) => {
    const source = toolingIssueSource(provenance, name, relativePath);
    return { path: ["tooling", name, ...relativePath], ...(source === undefined ? {} : { source }) };
  });
