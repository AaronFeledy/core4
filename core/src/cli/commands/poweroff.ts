import {
  type PoweroffAppResult,
  type PoweroffError,
  type PoweroffOptions,
  type PoweroffResult,
  PoweroffResultSchema,
  type PoweroffServices,
  PoweroffStopError,
  poweroff,
} from "@lando/engine/operations/poweroff";

export {
  type PoweroffError,
  type PoweroffOptions,
  type PoweroffResult,
  PoweroffResultSchema,
  type PoweroffServices,
  PoweroffStopError,
  poweroff,
};

const labelApp = (app: PoweroffAppResult, duplicates: ReadonlySet<string>): string =>
  duplicates.has(app.appId) && app.appRoot !== "" ? `${app.appId} (${app.appRoot})` : app.appId;

/** Render the engine's per-app outcome, naming roots only when the same id appears twice. */
export const renderPoweroffResult = (result: PoweroffResult): string => {
  const lines: string[] = [];
  const ids = result.apps.map((app) => app.appId);
  const duplicates = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  const poweredOff = result.apps.filter((app) => app.outcome === "stopped" || app.outcome === "unchanged");
  const destroyed = result.apps.filter((app) => app.outcome === "destroyed");
  if (poweredOff.length > 0)
    lines.push(`Powered off: ${poweredOff.map((app) => labelApp(app, duplicates)).join(", ")}`);
  if (destroyed.length > 0)
    lines.push(`Destroyed scratch apps: ${destroyed.map((app) => app.appId).join(", ")}`);
  if (lines.length === 0) lines.push("No Lando apps to power off.");
  if (result.keptGlobalApp) lines.push("kept global app running");
  if (result.keptScratchApps > 0) {
    const plural = result.keptScratchApps === 1 ? "" : "s";
    lines.push(`kept ${result.keptScratchApps} scratch app${plural} running`);
  }
  if (result.runtimeServiceStopped) lines.push("Stopped Lando runtime service");
  return lines.join("\n");
};
