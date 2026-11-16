import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Option, Schema } from "effect";
import { encodeEngineFilters } from "./engine-json.ts";
import type { HelperOwnerIdentity } from "./helper-owner.ts";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  DATA_HELPER_ROLE,
  HELPER_LIFECYCLE_LABEL,
  HELPER_LIFECYCLE_PROCESS,
  HELPER_LIFECYCLE_RETAIN,
  HELPER_OWNER_BOOT_LABEL,
  HELPER_OWNER_MACHINE_LABEL,
  HELPER_OWNER_PID_DOMAIN_LABEL,
  HELPER_OWNER_PID_LABEL,
  HELPER_OWNER_START_LABEL,
  PROVIDER_LABEL,
  ROLE_LABEL,
  STORE_LABEL,
} from "./labels.ts";
import { redactString, withApiReason } from "./redact.ts";

export const ephemeralDataHelperLabels = (input: {
  readonly providerId: string;
  readonly app?: string;
  readonly appRoot?: string;
  readonly store?: string;
  readonly remove?: boolean;
  readonly owner?: HelperOwnerIdentity;
}): Readonly<Record<string, string>> => {
  const lifecycle =
    input.remove === false
      ? HELPER_LIFECYCLE_RETAIN
      : input.owner === undefined
        ? undefined
        : HELPER_LIFECYCLE_PROCESS;
  return {
    [ROLE_LABEL]: DATA_HELPER_ROLE,
    [PROVIDER_LABEL]: input.providerId,
    ...(input.app === undefined ? {} : { [APP_LABEL]: input.app }),
    ...(input.appRoot === undefined ? {} : { [APP_ROOT_LABEL]: input.appRoot }),
    ...(input.store === undefined ? {} : { [STORE_LABEL]: input.store }),
    ...(lifecycle === undefined ? {} : { [HELPER_LIFECYCLE_LABEL]: lifecycle }),
    ...(input.owner === undefined
      ? {}
      : {
          [HELPER_OWNER_MACHINE_LABEL]: input.owner.machine,
          [HELPER_OWNER_PID_DOMAIN_LABEL]: input.owner.pidDomain,
          [HELPER_OWNER_PID_LABEL]: String(input.owner.pid),
          ...(input.owner.boot === undefined ? {} : { [HELPER_OWNER_BOOT_LABEL]: input.owner.boot }),
          ...(input.owner.start === undefined ? {} : { [HELPER_OWNER_START_LABEL]: input.owner.start }),
        }),
  };
};

const Holder = Schema.Struct({
  Id: Schema.String,
  Names: Schema.Array(Schema.String),
  Mounts: Schema.Array(Schema.Struct({ Type: Schema.String, Name: Schema.optionalKey(Schema.String) })),
});
const Holders = Schema.fromJsonString(Schema.Array(Holder));

export interface VolumeHolder {
  readonly id: string;
  readonly name: string;
}

// Discovery is diagnostic only: stopped containers may still belong to an active output drain.
export const listVolumeHolders = (
  request: (input: {
    readonly method: "GET";
    readonly path: `/${string}`;
  }) => Effect.Effect<{ readonly status: number; readonly body: string }, unknown>,
  volumeName: string,
): Effect.Effect<ReadonlyArray<VolumeHolder>> =>
  request({
    method: "GET",
    path: `/containers/json?all=true&filters=${encodeEngineFilters({ volume: [volumeName] })}`,
  }).pipe(
    Effect.map((response) => {
      if (response.status !== 200) return [];
      const decoded = Schema.decodeUnknownOption(Holders)(response.body);
      if (Option.isNone(decoded)) return [];
      return decoded.value.flatMap((holder) =>
        holder.Id.length > 0 &&
        holder.Mounts.some((mount) => mount.Type === "volume" && mount.Name === volumeName)
          ? [
              {
                id: holder.Id,
                name: holder.Names[0]?.replace(/^\//u, "") || holder.Id,
              },
            ]
          : [],
      );
    }),
    Effect.catch(() => Effect.succeed([])),
    Effect.timeoutOption("1 second"),
    Effect.map(Option.getOrElse(() => [])),
  );

export const isVolumeInUse = (details: unknown): boolean => {
  if (typeof details !== "object" || details === null) return false;
  if (!("body" in details) || typeof details.body !== "string") return false;
  return (
    ("status" in details && details.status === 409) || /\b(?:in use|being used by)\b/i.test(details.body)
  );
};

export const volumeInUseRemediation = (redactor: Redactor): string =>
  redactString(
    "A container still uses this volume. Wait for any running data operation to finish, then retry. Lando removes a leftover data helper that holds the volume once it confirms the Lando process that started the helper has exited. Run `lando doctor` to check the runtime.",
    redactor,
  );

export const volumeInUseMessage = (
  base: string,
  holders: ReadonlyArray<VolumeHolder>,
  details: unknown,
  redactor: Redactor,
): string => {
  const named =
    holders.length === 0
      ? base
      : `${base} Held by ${holders.map((holder) => `${holder.name} (${holder.id})`).join(", ")}.`;
  const withReason = withApiReason(named, details, redactor);
  const body =
    typeof details === "object" && details !== null && "body" in details && typeof details.body === "string"
      ? details.body.trim()
      : "";
  return redactString(withReason === named && body.length > 0 ? `${named} ${body}` : withReason, redactor);
};

/** `commandFinished` is true when the helper's command ran to completion and only its container is left. */
export const leftoverHelperRemediation = (redactor: Redactor, commandFinished: boolean): string =>
  redactString(
    `${commandFinished ? "The command already finished. " : ""}Lando removes the leftover helper container automatically once it confirms the Lando process that started it has exited, during a later database or snapshot command or when it holds a volume removal. Run \`lando doctor\` to check the runtime.`,
    redactor,
  );
