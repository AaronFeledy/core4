import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import {
  type AppConfigMigrateOptions,
  type AppConfigMigrateResult,
  AppConfigMigrateResultSchema,
  appConfigMigrate,
  renderAppConfigMigrateResult,
} from "../../../commands/app-config-migrate";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { yesFlag } from "../../../spec/confirmation-flag";
import { Flags } from "../../../spec/metadata";

export const appConfigMigrateOptionsFromInput = (input: unknown): AppConfigMigrateOptions => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return {};
  const flags = input.flags;
  if (typeof flags !== "object" || flags === null) return {};
  return {
    dryRun: "dry-run" in flags && flags["dry-run"] === true,
    yes: "yes" in flags && flags.yes === true,
    nonInteractive:
      ("no-interactive" in flags && flags["no-interactive"] === true) ||
      ("non-interactive" in flags && flags["non-interactive"] === true),
  };
};

export const appConfigMigrateSpec: LandoCommandSpec<AppConfigMigrateResult> = {
  resultSchema: AppConfigMigrateResultSchema,
  id: "app:config:migrate",
  summary: "Migrate managed recipe configuration through satisfied recipe history.",
  namespace: "app",
  topLevelAlias: false,
  aliases: ["config:migrate"],
  bootstrap: "minimal",
  flags: {
    "dry-run": Flags.boolean({
      description: "Preview every migration hunk without writing.",
      default: false,
    }),
    yes: yesFlag("Approve selectable migration hunks."),
    "no-interactive": Flags.boolean({
      aliases: ["non-interactive"],
      description: "Never prompt for migration approval.",
      default: false,
    }),
    format: Flags.string({ description: "Output format.", default: "text" }),
  },
  run: Effect.fn("ConfigMigrateCommand.run")(function* (input: unknown) {
    const privateFileAccess = yield* PrivateFileAccessService;
    return yield* appConfigMigrate({
      ...appConfigMigrateOptionsFromInput(input),
      privateFileAccess,
    });
  }),
  render: renderAppConfigMigrateResult,
};
