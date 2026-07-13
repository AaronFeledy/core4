import { join } from "node:path";

import { LandofileFormConflictError } from "@lando/sdk/errors";

import type { VersionConstraintEntry } from "../config/version-constraint.ts";

export interface LandofileLayerPosition {
  readonly layer: VersionConstraintEntry["layer"];
  readonly order: VersionConstraintEntry["order"];
  readonly basename: string;
}

export const LANDOFILE_LAYER_POSITIONS: ReadonlyArray<LandofileLayerPosition> = [
  { layer: "base", order: 0, basename: ".lando.base" },
  { layer: "dist", order: 1, basename: ".lando.dist" },
  { layer: "upstream", order: 2, basename: ".lando.upstream" },
  { layer: "canonical", order: 3, basename: ".lando" },
  { layer: "local", order: 4, basename: ".lando.local" },
  { layer: "user", order: 5, basename: ".lando.user" },
];

export interface PresentLandofileLayer extends LandofileLayerPosition {
  readonly filePath: string;
}

export const presentLandofileLayers = async (
  appRoot: string,
): Promise<ReadonlyArray<PresentLandofileLayer>> => {
  const present: PresentLandofileLayer[] = [];
  for (const position of LANDOFILE_LAYER_POSITIONS) {
    const yamlPath = join(appRoot, `${position.basename}.yml`);
    const typescriptPath = join(appRoot, `${position.basename}.ts`);
    const [yamlExists, typescriptExists] = await Promise.all([
      Bun.file(yamlPath).exists(),
      Bun.file(typescriptPath).exists(),
    ]);
    if (yamlExists && typescriptExists) {
      throw new LandofileFormConflictError({
        message: `Both ${yamlPath} and ${typescriptPath} are present for the ${position.layer} Landofile layer.`,
        layer: position.layer,
        yamlPath,
        typescriptPath,
        remediation: `Remove either ${yamlPath} or ${typescriptPath}; each layer accepts exactly one form.`,
      });
    }
    const filePath = yamlExists ? yamlPath : typescriptExists ? typescriptPath : undefined;
    if (filePath !== undefined) present.push({ ...position, filePath });
  }
  return present;
};
