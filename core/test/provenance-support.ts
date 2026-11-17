import {
  type LandofileProvenance,
  authoredDocumentFrom,
  provenanceOf as provenanceIn,
} from "@lando/landofile/provenance";

export { provenanceIn };

/** A provenance record for fixtures that hand-build a value. */
export const fixtureProvenance = (patch: Partial<LandofileProvenance> = {}): LandofileProvenance => ({
  ...authoredDocumentFrom({}, { file: "/app/.lando.yml", layer: "canonical", path: [] }).provenance,
  ...patch,
});

/** Attach internal tooling task ids without adding an authored key to the fixture document. */
export const withInternalToolingTasks = <T extends object>(value: T, ids: readonly string[]): T =>
  Object.defineProperty({ ...value }, "provenance", {
    value: { ...(provenanceIn(value) ?? fixtureProvenance()), internalToolingTasks: [...ids] },
    enumerable: false,
    configurable: true,
  });
