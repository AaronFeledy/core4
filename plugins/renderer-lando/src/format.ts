import { renderPlainLine } from "@lando/sdk/renderer";
import type { LandoEvent } from "@lando/sdk/services";

import { csi } from "./task-tree-frame.ts";
import { truncateToWidth, wrapWordsToWidth } from "./terminal-width.ts";

export * from "@lando/sdk/renderer";

const renderNotice = (body: string, severity: "info" | "warn", columns?: number): string => {
  const label = severity === "info" ? "INFO" : "WARNING";
  const accent = severity === "info" ? csi.cyan : csi.amber;
  const terminalWidth = columns !== undefined && Number.isFinite(columns) ? Math.trunc(columns) : 80;
  const width = Math.max(1, Math.min(100, terminalWidth - 1));
  const paragraphs = body.split(/\r?\n/u);

  if (width < label.length + 3) {
    return [
      `${accent}${csi.bold}${truncateToWidth(label, width)}${csi.reset}`,
      ...paragraphs.flatMap((paragraph) => wrapWordsToWidth(paragraph, width)),
    ].join("\n");
  }

  const lines = paragraphs.flatMap((paragraph) => wrapWordsToWidth(paragraph, width - 2));
  return [
    `${accent}${csi.bold}╭─ ${label}${csi.reset}`,
    ...lines.map((line) => `${accent}│${csi.reset} ${line}`),
    `${accent}╰─${csi.reset}`,
  ].join("\n");
};

export const renderLandoLine = (
  event: LandoEvent,
  isTTY: boolean,
  terminalColumns?: number,
): string | null => {
  if (isTTY && (event._tag === "message.info" || event._tag === "message.warn")) {
    const body = Reflect.get(event, "body");
    return renderNotice(
      typeof body === "string" ? body : "",
      event._tag === "message.info" ? "info" : "warn",
      terminalColumns,
    );
  }
  return renderPlainLine(event);
};
