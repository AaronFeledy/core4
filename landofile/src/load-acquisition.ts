import { LandofileIncludeError, LandofileValidationError } from "@lando/sdk/errors";
import {
  type ValueOrigins,
  isLandofileOverride,
  isPlainRecord,
  mergeLandofiles,
  override,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { Result } from "effect";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import { attributeIncludeError } from "./include-guard.ts";
import { decodeIncludeAcquisition, includeAcquisitionView } from "./include-layer-overlays.ts";
import { type LoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
import { assertCompatibleIncludeFields } from "./tooling-include-entries.ts";
import { validationErrorFromCause } from "./validation.ts";

export const prepareIncludeAcquisition = (
  document: Record<string, unknown>,
  context: { readonly recorder: LoadFailureRecorder; readonly source: AuthoredOrigin },
): Record<string, unknown> => {
  if (["includes", "include", "toolingIncludes", "lando"].every((key) => document[key] === undefined))
    return document;
  if (context.recorder.blocked.length === 0) {
    const acquisition = decodeIncludeAcquisition(document);
    if (Result.isSuccess(acquisition) && assertCompatibleIncludeFields(acquisition.success) === undefined)
      return document;
  }
  const origins =
    getOrigins(document) ?? withValueOrigins(document, (path) => ({ ...context.source, path })).origins;
  const children = new Map(origins.children);
  const projection = mergeLandofiles([
    Object.fromEntries(
      ["includes", "include", "toolingIncludes", "lando"].flatMap((key) =>
        Object.hasOwn(document, key) ? [[key, document[key]]] : [],
      ),
    ),
  ]);
  const result = { ...document };
  for (const key of ["includes", "include", "toolingIncludes", "lando"] as const) {
    const value = projection[key];
    if (value === undefined) continue;
    let parts: [string | number | undefined, unknown][];
    if (Array.isArray(value)) parts = value.map((entry, index) => [index, entry]);
    else if (key === "toolingIncludes" && isPlainRecord(value)) parts = Object.entries(value);
    else parts = [[undefined, value]];
    const accepted: [string | number | undefined, unknown][] = [];
    const entryOrigins = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
    for (const [part, entry] of parts) {
      const path = part === undefined ? [key] : [key, part];
      const source = origins.children.get(key)?.children.get(part ?? "")?.source ?? {
        ...context.source,
        path,
      };
      if (loadPathBlocked(context.recorder, source)) continue;
      let candidateValue = entry;
      if (typeof part === "number") candidateValue = [entry];
      else if (part !== undefined) candidateValue = { [part]: entry };
      const candidate = { [key]: candidateValue };
      const decoded = Result.try({
        try: () => includeAcquisitionView(candidate),
        catch: (cause) => validationErrorFromCause(context.source.file, candidate, cause),
      });
      if (Result.isFailure(decoded)) {
        const error = decoded.failure;
        context.recorder.record(
          new LandofileValidationError({
            message: error.message,
            file: error.file,
            remediation: error.remediation,
            issues: error.issues.map((issue) => {
              const issuePath = [...path, ...issue.path.slice(part === undefined ? 1 : 2)];
              return { ...issue, path: issuePath, source: { ...source, path: issuePath } };
            }),
          }),
          source,
        );
        continue;
      }
      const incompatible = assertCompatibleIncludeFields(decoded.success);
      if (incompatible !== undefined) {
        context.recorder.record(
          attributeIncludeError(
            new LandofileIncludeError({
              message: incompatible.message,
              source: incompatible.source,
              kind: incompatible.kind,
              remediation: incompatible.remediation,
              path,
            }),
            source,
          ),
          source,
        );
        continue;
      }
      const node =
        part === undefined ? origins.children.get(key) : origins.children.get(key)?.children.get(part);
      if (node !== undefined && part !== undefined)
        entryOrigins.set(typeof part === "number" ? accepted.length : part, node);
      accepted.push([part, entry]);
    }
    if (Array.isArray(value)) {
      const entries = accepted.map(([, entry]) => entry);
      result[key] = isLandofileOverride(document[key]) ? override(entries) : entries;
    } else if (key === "toolingIncludes" && isPlainRecord(value))
      result[key] = Object.fromEntries(accepted.map(([part, entry]) => [part, entry]));
    else if (accepted.length === 0) delete result[key];
    else result[key] = value;
    const node = children.get(key);
    if (node !== undefined && (Array.isArray(value) || key === "toolingIncludes"))
      children.set(key, { ...node, children: entryOrigins });
  }
  return rememberOrigins(copyLandofileProvenance(document, result), { ...origins, children });
};
