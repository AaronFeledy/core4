import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";

import { Flags } from "../../../spec/metadata";

import {
  type AppConfigTranslateResult,
  AppConfigTranslateResultSchema,
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../../commands/app-config-translate";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { extractSpecFlags } from "../../../spec/command-boundary";

export const appConfigTranslateSpec: LandoCommandSpec<AppConfigTranslateResult> = {
  resultSchema: AppConfigTranslateResultSchema,
  id: "app:config:translate",
  summary: "Translate a non-canonical config file into a canonical v4 Landofile.",
  namespace: "app",
  recipePostInitAllowed: true,
  topLevelAlias: false,
  aliases: ["config:translate"],
  bootstrap: "plugins",
  flags: {
    list: Flags.boolean({
      description: "List installed config translators and their input kinds.",
      default: false,
    }),
    detect: Flags.boolean({
      description: "Detect supported source files without generating a translated Landofile preview.",
      default: false,
    }),
    from: Flags.string({
      description: "Force a specific translator by id instead of autodetecting.",
    }),
    to: Flags.string({
      description: "Target encoder id. Only `lando4` may write; other targets are preview-only.",
      default: "lando4",
    }),
    file: Flags.string({
      description: "Translate an explicit source file (repeatable). Scopes translator input.",
      multiple: true,
    }),
    write: Flags.boolean({
      description:
        "Write the declared v4 Landofile layers through the managed-file transaction; an immutable digest-named backup is kept beside each replaced file.",
      default: false,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["yaml", "table", "json"],
      default: "yaml",
    }),
  },
  run: (input) =>
    Effect.gen(function* () {
      const flags = extractSpecFlags(input);
      const files = Array.isArray(flags.file)
        ? flags.file.filter((file): file is string => typeof file === "string")
        : undefined;
      const privateFileAccess = yield* PrivateFileAccessService;
      return yield* appConfigTranslate({
        write: flags.write === true,
        list: flags.list === true,
        detect: flags.detect === true,
        ...(typeof flags.from === "string" ? { from: flags.from } : {}),
        ...(typeof flags.to === "string" ? { to: flags.to } : {}),
        ...(files === undefined ? {} : { files }),
        privateFileAccess,
      });
    }),
  render: (result) => renderConfigTranslateResult(result as AppConfigTranslateResult, "yaml"),
};
