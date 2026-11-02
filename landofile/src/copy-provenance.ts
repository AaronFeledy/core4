import { getLandofileAppRoot, rememberLandofileAppRoot } from "./app-root-provenance.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  hasLandofileIncludeSources,
  hasLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import {
  getLandofileReferencedFiles,
  hasLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import { copyOrigins } from "./pipeline/origins.ts";
import { getSourceDocuments, rememberSourceDocuments } from "./pipeline/source-table.ts";
import {
  getInternalToolingTasks,
  hasInternalToolingTasks,
  rememberInternalToolingTasks,
} from "./tooling-include-provenance.ts";
import {
  getVersionConstraintEntries,
  hasVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "./version-constraint.ts";

/** Transfer remembered metadata without synthesizing absent provenance. */
export const copyLandofileProvenance = <T extends object>(from: object, to: T): T => {
  copyOrigins(from, to);
  const documents = getSourceDocuments(from);
  if (documents.length > 0) rememberSourceDocuments(to, documents);
  const appRoot = getLandofileAppRoot(from);
  if (appRoot !== undefined) rememberLandofileAppRoot(to, appRoot);
  if (hasLocalIncludePaths(from)) rememberLocalIncludePaths(to, getLocalIncludePaths(from));
  if (hasLandofileIncludeSources(from)) {
    rememberLandofileIncludeSources(to, getLandofileIncludeSources(from));
  }
  if (hasLandofileReferencedFiles(from)) {
    rememberLandofileReferencedFiles(to, getLandofileReferencedFiles(from));
  }
  if (hasInternalToolingTasks(from)) rememberInternalToolingTasks(to, getInternalToolingTasks(from));
  if (hasVersionConstraintEntries(from)) {
    rememberVersionConstraintEntries(to, getVersionConstraintEntries(from, ""));
  }
  return to;
};
