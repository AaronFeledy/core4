import { dirname, isAbsolute } from "node:path";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { parseExpressionEither } from "@lando/sdk/expressions";
import {
  type ValueOrigins,
  isLandofileOverride,
  isPlainRecord,
  mergeLandofiles,
  override,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { Effect, Result } from "effect";
import { authoredSiteId } from "./compiled-sites.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import {
  hasIncludeConditions,
  includeConditionPath,
  withoutIncludeCondition,
} from "./include-condition-shape.ts";
import type { ResolveLandofileIncludesOptions } from "./include-context.ts";
import type { LandofileLoadPolicy, LandofileLoadSource } from "./load-expression-file.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import { resolveLandofileLoadExpressions } from "./load-expression.ts";
import { createLoadFailureRecorder, finishLoadStage, loadPathBlocked } from "./load-failures.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
import { validationErrorFromCause } from "./validation.ts";

export interface IncludeMaterializationContext {
  readonly source: LandofileLoadSource;
  readonly policy: LandofileLoadPolicy;
  readonly scope: LandofileLoadScope;
  readonly onRelaxedRead?: ResolveLandofileIncludesOptions["onRelaxedRead"];
}

export const materializeIncludeConditions = Effect.fnUntraced(function* (
  document: Record<string, unknown>,
  context: IncludeMaterializationContext,
) {
  if (!hasIncludeConditions(document)) return document;
  const recorder = context.scope.recorder ?? createLoadFailureRecorder();
  const scope = { ...context.scope, recorder, pendingSites: context.scope.pendingSites ?? [] };
  const origins =
    getOrigins(document) ??
    withValueOrigins(document, (path) => ({
      file: context.source.sourcePath,
      layer: context.source.layer,
      path,
    })).origins;
  const projection = mergeLandofiles([
    Object.fromEntries(
      ["includes", "toolingIncludes"].flatMap((key) =>
        Object.hasOwn(document, key) ? [[key, document[key]]] : [],
      ),
    ),
  ]);
  const targets: {
    readonly key: "includes" | "toolingIncludes";
    readonly part: string | number;
    readonly value: unknown;
  }[] = [
    ...(Array.isArray(projection.includes)
      ? projection.includes.map((value: unknown, index) => ({ key: "includes" as const, part: index, value }))
      : []),
    ...(isPlainRecord(projection.toolingIncludes)
      ? Object.entries(projection.toolingIncludes).map(([part, value]) => ({
          key: "toolingIncludes" as const,
          part,
          value,
        }))
      : []),
  ];
  if (!targets.some(({ value }) => isPlainRecord(value) && Object.hasOwn(value, "when"))) return document;
  const candidates = copyLandofileProvenance(document, {
    ...document,
    ...(projection.includes === undefined ? {} : { includes: projection.includes }),
    ...(projection.toolingIncludes === undefined ? {} : { toolingIncludes: projection.toolingIncludes }),
  });
  const nodeAt = (target: (typeof targets)[number]): ValueOrigins<AuthoredOrigin> =>
    origins.children.get(target.key)?.children.get(target.part) ??
    withValueOrigins(target.value, (path) => ({
      file: context.source.sourcePath,
      layer: context.source.layer,
      path: [target.key, target.part, ...path],
    })).origins;
  const conditionIds = new Set<string>();
  if (scope.includeMode !== "all") {
    for (const target of targets) {
      if (!isPlainRecord(target.value) || typeof target.value.when !== "string") continue;
      const node = nodeAt(target);
      const source = node.children.get("when")?.source ?? {
        ...node.source,
        path: [...node.source.path, "when"],
      };
      if (loadPathBlocked(recorder, source)) continue;
      const id = authoredSiteId(source);
      conditionIds.add(id);
      if (scope.pendingSites.some((site) => site.id === id)) continue;
      const parsed = parseExpressionEither(target.value.when, {
        filePath: source.file,
        bareShellParameters: "preserve",
      });
      if (Result.isFailure(parsed)) {
        recorder.record(
          new ConfigExpressionError({
            message: parsed.failure.message,
            filePath: source.file,
            path: source.path,
            source,
            expression: target.value.when,
            remediation: "Use a whole-value boolean expression over recipe and env.",
          }),
          source,
        );
        continue;
      }
      scope.pendingSites.push({
        id,
        path: [target.key, target.part, "when"],
        source,
        template: parsed.success,
      });
    }
  }
  const materialized =
    scope.includeMode === "all"
      ? candidates
      : yield* materializeLandofileLayer(context.source.sourcePath, rememberOrigins(candidates, origins), {
          ...scope,
          siteFilter: (site) => includeConditionPath(site.path),
        });
  for (let index = scope.pendingSites.length - 1; index >= 0; index--)
    if (conditionIds.has(scope.pendingSites[index]?.id ?? "")) scope.pendingSites.splice(index, 1);
  if (!isPlainRecord(materialized))
    return yield* Effect.fail(validationErrorFromCause(context.source.sourcePath, materialized, undefined));
  const children = new Map(origins.children);
  const includes: unknown[] = [];
  const toolingIncludes: Record<string, unknown> = {};
  const includeOrigins = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
  const toolingOrigins = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
  const dependencies = [...getLandofileReferencedFiles(document)];
  for (const target of targets) {
    const node = nodeAt(target);
    const container = materialized[target.key];
    const entry: unknown = Array.isArray(container)
      ? container[Number(target.part)]
      : isPlainRecord(container)
        ? container[String(target.part)]
        : target.value;
    const conditional = isPlainRecord(entry) && Object.hasOwn(entry, "when");
    if (
      conditional &&
      scope.includeMode !== "all" &&
      (entry.when === false || loadPathBlocked(recorder, node.source))
    )
      continue;
    if (conditional && scope.includeMode !== "all" && typeof entry.when !== "boolean") {
      const source = node.children.get("when")?.source ?? {
        ...node.source,
        path: [...node.source.path, "when"],
      };
      recorder.record(
        new ConfigExpressionError({
          message: "An include condition must resolve to a boolean.",
          path: source.path,
          source,
          filePath: source.file,
          expression: String(entry.when),
          remediation: "Use a boolean or a whole-value boolean expression over recipe and env.",
        }),
        source,
      );
      continue;
    }
    let accepted = entry;
    let acceptedOrigins = node;
    if (conditional) {
      const rest = withoutIncludeCondition(entry);
      const fields = new Map(node.children);
      fields.delete("when");
      acceptedOrigins = { ...node, children: fields };
      const resolved = yield* resolveLandofileLoadExpressions({
        value: rest,
        source: {
          ...context.source,
          sourcePath: node.source.file,
          sourceRoot: isAbsolute(node.source.file) ? dirname(node.source.file) : context.source.sourceRoot,
          layer: node.source.layer,
        },
        policy: context.policy,
        recorder,
        pendingSites: scope.pendingSites,
        pathPrefix: node.source.path,
      });
      accepted = resolved.value;
      dependencies.push(...resolved.dependencies);
      const onRelaxedRead = context.onRelaxedRead;
      if (onRelaxedRead !== undefined)
        yield* Effect.forEach(resolved.relaxedReads, (read) =>
          onRelaxedRead({
            ...read,
            sourcePath: node.source.file,
            appRoot: context.source.appRoot,
          }),
        );
    }
    if (target.key === "includes") {
      includeOrigins.set(includes.length, acceptedOrigins);
      includes.push(accepted);
    } else {
      toolingOrigins.set(target.part, acceptedOrigins);
      toolingIncludes[String(target.part)] = accepted;
    }
  }
  const result = { ...materialized };
  if (Array.isArray(projection.includes)) {
    result.includes = isLandofileOverride(document.includes) ? override(includes) : includes;
    const node = origins.children.get("includes");
    if (node !== undefined) children.set("includes", { ...node, children: includeOrigins });
  }
  if (isPlainRecord(projection.toolingIncludes)) {
    result.toolingIncludes = toolingIncludes;
    const node = origins.children.get("toolingIncludes");
    if (node !== undefined) children.set("toolingIncludes", { ...node, children: toolingOrigins });
  }
  if (context.scope.recorder === undefined) yield* finishLoadStage(context.source.sourcePath, recorder);
  return rememberLandofileReferencedFiles(
    rememberOrigins(copyLandofileProvenance(document, result), { ...origins, children }),
    dependencies,
  );
});
