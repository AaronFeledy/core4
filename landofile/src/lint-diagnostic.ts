import type { LandofileLoadFailure } from "@lando/sdk/errors";
import type { ValueOrigins } from "@lando/sdk/landofile";
import {
  type ConfigLintSkip,
  LandofileLayer,
  type LoadScopedLandofile,
  type ValidationIssuePath,
} from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import { authoredSiteId } from "./compiled-sites.ts";
import type { RecordedLoadFailure } from "./load-failures.ts";
import type { AuthoredDocument, AuthoredOrigin } from "./provenance.ts";
import { loadEntrySections, pathsOverlap, unavailableEntryPath } from "./validation-path.ts";
import { valueAtPath } from "./validation-suggestions.ts";

export interface LoadUnavailableSite {
  readonly path: ValidationIssuePath;
  readonly failure: LandofileLoadFailure;
  readonly source: NonNullable<ConfigLintSkip["source"]>;
}

export interface LandofileLintDiagnostic {
  readonly landofile: LoadScopedLandofile;
  readonly unavailable: readonly LoadUnavailableSite[];
}

export const diagnosticUnavailableSites = (
  assembled: AuthoredDocument,
  failures: readonly RecordedLoadFailure[],
): Result.Result<readonly LoadUnavailableSite[], RecordedLoadFailure | undefined> => {
  const globalFailure = failures.find((entry) => entry.kind !== "local" || !("file" in entry.source));
  if (globalFailure !== undefined) return Result.fail(globalFailure);
  if (typeof assembled.value.name !== "string" || assembled.value.name.trim() === "")
    return Result.fail(failures[0]);
  const destinations = new Map<string, ValidationIssuePath[]>();
  const visit = (node: ValueOrigins<AuthoredOrigin>, path: ValidationIssuePath): void => {
    if (node.deleted || valueAtPath(assembled.value, path) === undefined) return;
    const id = authoredSiteId(node.source);
    const paths = destinations.get(id);
    if (paths === undefined) destinations.set(id, [path]);
    else paths.push(path);
    for (const [key, child] of node.children) visit(child, [...path, key]);
  };
  visit(assembled.provenance.origins, []);
  const unavailable: LoadUnavailableSite[] = [];
  for (const entry of failures) {
    if (entry.kind !== "local" || !("file" in entry.source) || !Schema.is(LandofileLayer)(entry.source.layer))
      return Result.fail(entry);
    const paths = destinations.get(authoredSiteId(entry.normalizedContainer ?? entry.source));
    if (paths === undefined) {
      if (entry.normalizedContainer !== undefined) return Result.fail(entry);
      const source = entry.source;
      const authored = assembled.provenance.documents.some(
        (document) =>
          document.file === source.file &&
          document.layer === source.layer &&
          valueAtPath(document.document, source.path) !== undefined,
      );
      if (!authored) return Result.fail(entry);
      continue;
    }
    for (const path of paths) {
      // A missing app-wide input can change the meaning of unrelated entries.
      if (
        path[0] !== "lando" &&
        (typeof path[1] !== "string" || !loadEntrySections.includes(String(path[0])))
      )
        return Result.fail(entry);
      unavailable.push({
        path,
        failure: entry.error,
        source: { ...entry.source, layer: entry.source.layer },
      });
    }
  }
  return Result.succeed(unavailable);
};

export const overlapsUnavailable = (
  path: ValidationIssuePath,
  unavailable: readonly LoadUnavailableSite[],
): boolean => unavailable.some(({ path: blocked }) => pathsOverlap(path, unavailableEntryPath(blocked)));
