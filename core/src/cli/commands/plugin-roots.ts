import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { NotImplementedError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

export const resolvePluginsRoot = Effect.fnUntraced(function* (
  options: { readonly userDataRoot?: string; readonly pluginsRoot?: string },
  commandId: string,
) {
  const userDataRoot = options.userDataRoot ?? (yield* (yield* ConfigService).get("userDataRoot"));
  if (userDataRoot === undefined) {
    return yield* Effect.fail(
      new NotImplementedError({
        message: "userDataRoot is not configured.",
        commandId,
        remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
      }),
    );
  }
  return options.pluginsRoot ?? makeLandoPaths({ userDataRoot }).pluginsDir;
});
