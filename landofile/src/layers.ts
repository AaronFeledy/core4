import { join } from "node:path";

import { LandofileFormConflictError } from "@lando/sdk/errors";
import { LANDOFILE_LAYER_ORDER } from "@lando/sdk/landofile";

import type { VersionConstraintEntry, VersionConstraintOrder } from "./version-constraint.ts";

export interface LandofileLayerPosition {
  readonly layer: VersionConstraintEntry["layer"];
  readonly order: VersionConstraintEntry["order"];
  readonly basename: string;
}

const LANDOFILE_LAYER_BASENAME = {
  base: ".lando.base",
  dist: ".lando.dist",
  upstream: ".lando.upstream",
  canonical: ".lando",
  local: ".lando.local",
  user: ".lando.user",
} as const satisfies Record<(typeof LANDOFILE_LAYER_ORDER)[number], string>;

const positionOrder = (index: number): VersionConstraintOrder => {
  switch (index) {
    case 0:
      return 0;
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    default:
      throw new Error(`Landofile layer index ${String(index)} is outside 0..5.`);
  }
};

export const LANDOFILE_LAYER_POSITIONS: ReadonlyArray<LandofileLayerPosition> = LANDOFILE_LAYER_ORDER.map(
  (layer, index) => ({
    layer,
    order: positionOrder(index),
    basename: LANDOFILE_LAYER_BASENAME[layer],
  }),
);

export interface PresentLandofileLayer extends LandofileLayerPosition {
  readonly filePath: string;
}

export const landofileLayerPaths = (
  appRoot: string,
): ReadonlyArray<LandofileLayerPosition & { readonly yamlPath: string; readonly typescriptPath: string }> =>
  LANDOFILE_LAYER_POSITIONS.map((position) => ({
    ...position,
    yamlPath: join(appRoot, `${position.basename}.yml`),
    typescriptPath: join(appRoot, `${position.basename}.ts`),
  }));

export const presentLandofileLayers = async (
  appRoot: string,
): Promise<ReadonlyArray<PresentLandofileLayer>> => {
  const present: PresentLandofileLayer[] = [];
  for (const position of landofileLayerPaths(appRoot)) {
    const { yamlPath, typescriptPath } = position;
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

export const representativeLandofileLayer = (
  layers: ReadonlyArray<PresentLandofileLayer>,
): PresentLandofileLayer | undefined => layers.find((layer) => layer.layer === "canonical") ?? layers[0];
