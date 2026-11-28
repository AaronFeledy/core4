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

const outcomeText: Record<PoweroffAppResult["outcome"], string> = {
  stopped: "stopped",
  unchanged: "nothing to stop",
  destroyed: "destroyed",
  skipped: "skipped",
};

const labelApp = (app: PoweroffAppResult, duplicates: ReadonlySet<string>): string =>
  duplicates.has(app.appId) && app.appRoot !== "" ? `${app.appId} (${app.appRoot})` : app.appId;

export const renderPoweroffResult = (result: PoweroffResult): string => {
  const lines: string[] = [];
  const ids = result.apps.map((app) => app.appId);
  const duplicates = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
  // An app whose post-step failed is reported only on its failure line, never as a plain success.
  const clean = result.apps.filter((app) => app.landofileEvents?.status !== "failed");
  const poweredOff = clean.filter((app) => app.outcome === "stopped");
  const unchanged = clean.filter((app) => app.outcome === "unchanged");
  const destroyed = clean.filter((app) => app.outcome === "destroyed");
  if (poweredOff.length > 0)
    lines.push(`Powered off: ${poweredOff.map((app) => labelApp(app, duplicates)).join(", ")}`);
  if (unchanged.length > 0)
    lines.push(`Nothing to stop: ${unchanged.map((app) => labelApp(app, duplicates)).join(", ")}`);
  if (destroyed.length > 0)
    lines.push(`Destroyed scratch apps: ${destroyed.map((app) => labelApp(app, duplicates)).join(", ")}`);
  for (const app of result.apps) {
    if (app.outcome === "skipped" && app.reason !== undefined)
      lines.push(`Skipped ${labelApp(app, duplicates)}: ${app.reason}`);
    const hook = app.landofileEvents;
    if (hook?.status !== "failed") continue;
    const { message, remediation } = hook.stepFailure;
    const label = app.appRoot === "" ? app.appId : `${app.appId} (${app.appRoot})`;
    lines.push(
      `${label}: ${outcomeText[app.outcome]}, but ${hook.event} failed. ${message} ${remediation}`.replace(
        /\s*\r?\n\s*/gu,
        " ",
      ),
    );
  }
  if (lines.length === 0) lines.push("No Lando apps to power off.");
  if (result.keptGlobalApp) lines.push("kept global app running");
  if (
    result.keptScratchApps > 0 &&
    !result.apps.some((app) => app.kind === "scratch" && app.outcome === "skipped")
  ) {
    const plural = result.keptScratchApps === 1 ? "" : "s";
    lines.push(`kept ${result.keptScratchApps} scratch app${plural} running`);
  }
  if (result.runtimeServiceStopped) lines.push("Stopped Lando runtime service");
  return lines.join("\n");
};
