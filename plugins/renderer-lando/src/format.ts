import { renderPlainLine } from "@lando/sdk/renderer";
import type { LandoEvent } from "@lando/sdk/services";

import { WARNED_MARKER } from "./task-tree-style.ts";

export * from "@lando/sdk/renderer";

export const renderLandoLine = (event: LandoEvent, isTTY: boolean): string | null => {
  if (isTTY && (event._tag === "message.info" || event._tag === "message.warn")) {
    const body = Reflect.get(event, "body");
    const marker = event._tag === "message.info" ? "i" : WARNED_MARKER;
    return `${marker} ${typeof body === "string" ? body : ""}`;
  }
  return renderPlainLine(event);
};
