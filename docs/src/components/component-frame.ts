import type { PublicTranscriptViewFrame } from "@lando/core/docs/render";

import { type ComponentFrameResolution, type FrameKind, resolveComponentFrame } from "../lib/frames.ts";
import { dataAttributesOf } from "./data-attributes.ts";

export type ComponentFrameProps = {
  readonly dataAttributes: Readonly<Record<string, unknown>>;
  readonly resolution: ComponentFrameResolution;
  readonly frame: PublicTranscriptViewFrame | undefined;
};

export const componentFramePropsFor = async (
  props: Readonly<Record<string, unknown>>,
  kind: FrameKind,
): Promise<ComponentFrameProps> => {
  const resolution = await resolveComponentFrame(props, kind);
  return {
    dataAttributes: dataAttributesOf(props),
    resolution,
    frame: resolution.status === "captured" ? resolution.frame : undefined,
  };
};
