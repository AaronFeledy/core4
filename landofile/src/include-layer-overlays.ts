import { mergeLandofiles } from "@lando/sdk/landofile";
import type { LandofileDecodedOverlay, LandofileShape } from "@lando/sdk/schema";

const overlaysByResolution = new WeakMap<object, ReadonlyArray<LandofileDecodedOverlay>>();

export const rememberIncludeOverlays = <T extends object>(
  value: T,
  overlays: ReadonlyArray<LandofileDecodedOverlay>,
): T => {
  overlaysByResolution.set(value, overlays);
  return value;
};

export const getIncludeOverlays = (value: LandofileShape): ReadonlyArray<LandofileDecodedOverlay> =>
  overlaysByResolution.get(value) ?? [value];

export const includeAcquisitionView = (overlay: LandofileDecodedOverlay): LandofileShape =>
  mergeLandofiles([overlay]) as LandofileShape;
