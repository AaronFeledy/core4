import { Effect } from "effect";
import { Flags } from "../../../spec/metadata";

import { EmptyResultSchema, type LandoCommandSpec } from "../../../spec/command-base";

/**
 * `lando meta:plugin:login` — write registry auth.
 *
 * `lando plugin:login` / `lando plugin:logout` write to
 * `<userConfRoot>/plugin-auth.json` and are consumed by the registry
 * plugin source for private packages.
 */

export const pluginLoginSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:login",
  summary: "Authenticate with a plugin source.",
  description: "Authenticate with a private plugin registry.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  flags: {
    registry: Flags.string({ description: "Registry URL.", required: true }),
  },
  deferred: {
    phase: "4.1",
    summary: "Plugin registry login/logout are not available yet.",
    remediation: "Plugin registry login/logout are not available yet.",
  },
  run: () => Effect.die("not yet implemented: meta:plugin:login"),
};
