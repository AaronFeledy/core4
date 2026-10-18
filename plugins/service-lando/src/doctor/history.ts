import { Effect } from "effect";

import type { PluginDoctorCheckContribution } from "@lando/sdk/plugins";
import { historyStoreName } from "@lando/sdk/schema";

export const historyDoctorCheck: PluginDoctorCheckContribution = {
  id: "history",
  run: Effect.fn("HistoryDoctorCheck.run")(function* (input) {
    const app = input.app;
    if (app === undefined) return [];
    const volume = historyStoreName(app.name);
    const inspection =
      input.resources === undefined
        ? undefined
        : yield* input.resources.inspect({ kind: "volume", namePrefix: volume, limit: 8 });
    const present =
      inspection?.status === "ok" ? (inspection.names.includes(volume) ? "true" : "false") : "unknown";
    const reason =
      inspection === undefined
        ? "no inspector"
        : inspection.status === "ok"
          ? present === "true"
            ? "present"
            : "absent"
          : inspection.reason;
    return [
      {
        name: "history",
        status: "pass" as const,
        severity: "info" as const,
        context: {
          volume,
          present,
          detail: reason,
        },
        solutions: [],
      },
    ];
  }),
};
