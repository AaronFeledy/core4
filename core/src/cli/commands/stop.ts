/** `lando stop` result rendering. */
import type { StopAppResult } from "@lando/sdk/app";
import { lifecycleLine, teardownLine, unchangedLine } from "./service-summary";
import { shutdownServiceRows } from "./shutdown-summary";

export const renderStopAppResult = (result: StopAppResult): string => {
  let line: string;
  if (result.runtimeState === "idle" && result.servicesStopped.length === 0) {
    line = `${result.outcome ?? "stopped"}: ${result.app} (runtime idle; nothing was running)`;
  } else if (result.outcome === "unchanged") {
    const alreadyStopped = [
      ...new Set(
        (result.containers ?? []).flatMap((container) =>
          container.action === "already-stopped" ? [String(container.service)] : [],
        ),
      ),
    ];
    line =
      alreadyStopped.length === 0
        ? unchangedLine(result.app)
        : lifecycleLine("unchanged", result.app, `already stopped: ${alreadyStopped.join(", ")}`);
  } else {
    line = teardownLine(
      "stopped",
      result.app,
      shutdownServiceRows(result.servicesStopped, result.shutdownObservations),
    );
  }
  const kept = result.servicesKeptRunning;
  return kept === undefined || kept.length === 0 ? line : `${line}; still running: ${kept.join(", ")}`;
};
