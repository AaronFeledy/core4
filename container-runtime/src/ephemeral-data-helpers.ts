import type { Redactor } from "@lando/sdk/secrets";
import { Effect, Option, Schema } from "effect";
import { encodeEngineFilters } from "./engine-json.ts";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  DATA_HELPER_ROLE,
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
}): Readonly<Record<string, string>> => ({
  [ROLE_LABEL]: DATA_HELPER_ROLE,
  [PROVIDER_LABEL]: input.providerId,
  ...(input.app === undefined ? {} : { [APP_LABEL]: input.app }),
  ...(input.appRoot === undefined ? {} : { [APP_ROOT_LABEL]: input.appRoot }),
  ...(input.store === undefined ? {} : { [STORE_LABEL]: input.store }),
});

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
  request: (input: { readonly method: "GET"; readonly path: `/${string}` }) => Effect.Effect<
    { readonly status: number; readonly body: string },
    unknown
  >,
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
          ? [{ id: holder.Id, name: holder.Names[0]?.replace(/^\//u, "") || holder.Id }]
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
    "A container still uses this volume. Wait for any data operation to finish, then inspect the holder before removing it and retrying. Lando cannot verify that a leftover helper is inactive.",
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
