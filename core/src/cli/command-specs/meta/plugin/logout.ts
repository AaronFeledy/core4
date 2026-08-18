import { Effect } from "effect";
import { Flags } from "../../../spec/metadata";

import { EmptyResultSchema, type LandoCommandSpec } from "../../../spec/command-base";

/**
 * `lando meta:plugin:logout` — clear registry auth.
 */

export const pluginLogoutSpec: LandoCommandSpec<never> = {
  resultSchema: EmptyResultSchema,
  id: "meta:plugin:logout",
  summary: "Forget plugin source authentication.",
  description: "Sign out of a private plugin registry.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  flags: {
    registry: Flags.string({ description: "Registry URL." }),
  },
  deferred: {
    phase: "4.1",
    summary: "Plugin registry login/logout are not available yet.",
    remediation: "Plugin registry login/logout are not available yet.",
  },
  run: () => Effect.die("not yet implemented: meta:plugin:logout"),
};
