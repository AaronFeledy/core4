import { hostEventStepLocation } from "@lando/sdk/schema";

export const eventStepLabel = (
  event: string,
  source: "host" | "project" | undefined,
  index: number,
): string => (source === "host" ? hostEventStepLocation(event, index) : `${event} step ${index + 1}`);

export const eventStepFile = (source: "host" | "project" | undefined, projectFile: string): string =>
  source === "host" ? "config.yml" : projectFile;
