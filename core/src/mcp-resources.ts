import { withResolvedCwd } from "@lando/engine/landofile/app-resolution";
import { AppInfoResultSchema } from "@lando/engine/operations/info";
import type { McpResourceEntry } from "@lando/mcp/service";
import { Effect } from "effect";
import { resolveApp } from "./app/resolve";
import { AppConfigResultSchema, appConfig, appConfigRedactionTokens } from "./cli/commands/app-config";
import { resilientDoctorReport } from "./cli/commands/doctor-bootstrap";
import { DoctorReportSchema } from "./cli/commands/doctor-report-contract";
import { AppsListResultSchema, listServices } from "./cli/commands/list";

export const resources: ReadonlyArray<McpResourceEntry> = [
  {
    uri: "lando://app/config",
    name: "App configuration",
    description: "Resolved configuration for the current app.",
    resultSchema: AppConfigResultSchema,
    redactionTokens: appConfigRedactionTokens,
    read: Effect.gen(function* () {
      const app = yield* resolveApp();
      return yield* withResolvedCwd(app.root, appConfig({ subcommand: "view" }));
    }),
  },
  {
    uri: "lando://app/info",
    name: "App information",
    description: "Services and endpoints for the current app.",
    resultSchema: AppInfoResultSchema,
    read: Effect.gen(function* () {
      const app = yield* resolveApp();
      return yield* app.info({ deep: true });
    }),
  },
  {
    uri: "lando://apps",
    name: "Apps",
    description: "Known apps and their services.",
    resultSchema: AppsListResultSchema,
    read: listServices(),
  },
  {
    uri: "lando://doctor",
    name: "Doctor",
    description: "Host-safe diagnostics without applying fixes.",
    resultSchema: DoctorReportSchema,
    read: resilientDoctorReport(),
  },
];
