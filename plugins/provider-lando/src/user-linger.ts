import { Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PrivilegeService, ProviderHostChangeRequest } from "@lando/sdk/services";

const PROVIDER_ID = "lando";
const ENABLE_LINGER_FLAG = "enable-linger";
const LOGINCTL = "/usr/bin/loginctl";

type UserLingerFailureStage = "host" | "privilege" | "enable";

interface UserLingerFailureDetails {
  readonly stage: UserLingerFailureStage;
  readonly uid?: number;
  readonly exitCode?: number;
  readonly stderr?: string;
}

export class UserLingerError extends ProviderUnavailableError {
  constructor(message: string, remediation: string, details: UserLingerFailureDetails) {
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message,
      remediation,
      details,
    });
  }
}

export interface ConfigureUserLingerOptions {
  readonly uid: number | undefined;
  readonly setupFlags: Readonly<Record<string, unknown>> | undefined;
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly consent: ((request: ProviderHostChangeRequest) => Effect.Effect<boolean>) | undefined;
}

export const configureUserLinger = (
  options: ConfigureUserLingerOptions,
): Effect.Effect<void, UserLingerError> =>
  Effect.gen(function* () {
    if (options.setupFlags?.[ENABLE_LINGER_FLAG] !== true) return;
    if (options.uid === undefined) {
      return yield* Effect.fail(
        new UserLingerError(
          "User lingering is available only for rootless Linux providers.",
          "Rerun `lando setup` without `--enable-linger` on this host.",
          { stage: "host" },
        ),
      );
    }

    const request: ProviderHostChangeRequest = {
      _tag: "enable-user-linger",
      uid: options.uid,
      reason: "Keep the Lando-managed rootless runtime available after logout.",
    };
    if (options.consent === undefined || !(yield* options.consent(request))) return;
    if (options.privilege === undefined) {
      return yield* Effect.fail(
        new UserLingerError(
          "The privilege service is unavailable, so Lando cannot enable user lingering.",
          "Enable lingering manually or rerun `lando setup --enable-linger` where privilege elevation is available.",
          { stage: "privilege", uid: options.uid },
        ),
      );
    }

    const result = yield* options.privilege.elevate([LOGINCTL, "enable-linger", String(options.uid)]);
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        new UserLingerError(
          `Failed to enable user lingering: ${result.stderr.trim() || `loginctl exited ${result.exitCode}`}`,
          "Resolve the loginctl failure, then rerun `lando setup --enable-linger`.",
          { stage: "enable", uid: options.uid, exitCode: result.exitCode, stderr: result.stderr },
        ),
      );
    }
  });
