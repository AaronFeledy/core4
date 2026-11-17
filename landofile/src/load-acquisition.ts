import { LandofileIncludeError, LandofileValidationError } from "@lando/sdk/errors";
import {
  type ValueOrigins,
  isLandofileOverride,
  isPlainRecord,
  mergeValuesWithOrigins,
  override,
  valueOriginAt,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { LandofileShape } from "@lando/sdk/schema";
import { Result } from "effect";
import { attributeIncludeError } from "./include-guard.ts";
import { decodeIncludeAcquisition, includeAcquisitionView } from "./include-layer-overlays.ts";
import { type LoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import type { AuthoredDocument, AuthoredOrigin } from "./provenance.ts";
import { assertCompatibleIncludeFields } from "./tooling-include-entries.ts";
import { validationErrorFromCause } from "./validation.ts";

const ACQUISITION_KEYS = ["includes", "include", "toolingIncludes", "lando"] as const;

export const prepareIncludeAcquisition = (
  document: AuthoredDocument,
  context: { readonly recorder: LoadFailureRecorder; readonly source: AuthoredOrigin },
): AuthoredDocument => {
  if (ACQUISITION_KEYS.every((key) => document.value[key] === undefined)) return document;
  if (context.recorder.blocked.length === 0) {
    const acquisition = decodeIncludeAcquisition(document.value);
    if (Result.isSuccess(acquisition) && assertCompatibleIncludeFields(acquisition.success) === undefined)
      return document;
  }
  const origins = document.provenance.origins;
  const children = new Map(origins.children);
  // Rebuild the projection with the document's own origins; directive materialization
  // must not relocate authored paths.
  const projection = mergeValuesWithOrigins(
    LandofileShape,
    withValueOrigins({}, () => origins.source),
    {
      value: Object.fromEntries(
        ACQUISITION_KEYS.flatMap((key) =>
          Object.hasOwn(document.value, key) ? [[key, document.value[key]]] : [],
        ),
      ),
      origins: {
        ...origins,
        children: new Map(
          ACQUISITION_KEYS.flatMap((key) => {
            const node = origins.children.get(key);
            return node === undefined ? [] : [[key, node] as const];
          }),
        ),
      },
    },
  );
  const projected = isPlainRecord(projection.value) ? projection.value : {};
  const result = { ...document.value };
  for (const key of ACQUISITION_KEYS) {
    const value = projected[key];
    if (value === undefined) continue;
    let parts: [string | number | undefined, unknown][];
    if (Array.isArray(value)) parts = value.map((entry, index) => [index, entry]);
    else if (key === "toolingIncludes" && isPlainRecord(value)) parts = Object.entries(value);
    else parts = [[undefined, value]];
    const accepted: [string | number | undefined, unknown][] = [];
    const entryOrigins = new Map<string | number, ValueOrigins<AuthoredOrigin>>();
    for (const [part, entry] of parts) {
      const path = part === undefined ? [key] : [key, part];
      const source = valueOriginAt(projection.origins, path).source;
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
      if (part !== undefined)
        entryOrigins.set(
          typeof part === "number" ? accepted.length : part,
          valueOriginAt(projection.origins, [key, part]),
        );
      accepted.push([part, entry]);
    }
    if (Array.isArray(value)) {
      const entries = accepted.map(([, entry]) => entry);
      result[key] = isLandofileOverride(document.value[key]) ? override(entries) : entries;
    } else if (key === "toolingIncludes" && isPlainRecord(value))
      result[key] = Object.fromEntries(accepted.map(([part, entry]) => [part, entry]));
    else if (accepted.length === 0) delete result[key];
    else result[key] = value;
    const node = projection.origins.children.get(key);
    if (node !== undefined && (Array.isArray(value) || key === "toolingIncludes"))
      children.set(key, { ...node, children: entryOrigins });
  }
  return { value: result, provenance: { ...document.provenance, origins: { ...origins, children } } };
};
