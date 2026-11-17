import {
  type LandofileProvenance,
  authoredDocumentFrom,
  provenanceOf as provenanceIn,
} from "@lando/landofile/provenance";

export { provenanceIn };

export const appRootOf = (value: object) => provenanceIn(value)?.appRoot;
export const documentsOf = (value: object) => provenanceIn(value)?.documents ?? [];
export const referencedFilesOf = (value: object) => provenanceIn(value)?.referencedFiles ?? [];
export const includeSourcesOf = (value: object) => provenanceIn(value)?.includeSources ?? [];
export const internalToolingTasksOf = (value: object) => provenanceIn(value)?.internalToolingTasks ?? [];

/** A provenance record for fixtures that hand-build a value. */
export const fixtureProvenance = (patch: Partial<LandofileProvenance> = {}): LandofileProvenance => ({
  ...authoredDocumentFrom({}, { file: "/app/.lando.yml", layer: "canonical", path: [] }).provenance,
  ...patch,
});

// Fixture documents stay authored-shaped: the carrier fact is not an authored key.
const withProvenance = <T extends object>(value: T, patch: Partial<LandofileProvenance>): T =>
  Object.defineProperty({ ...value }, "provenance", {
    value: { ...(provenanceIn(value) ?? fixtureProvenance()), ...patch },
    enumerable: false,
    configurable: true,
  });

export const withAppRoot = <T extends object>(value: T, root: string): T =>
  withProvenance(value, { appRoot: root });

export const withInternalToolingTasks = <T extends object>(value: T, ids: readonly string[]): T =>
  withProvenance(value, { internalToolingTasks: [...ids] });
