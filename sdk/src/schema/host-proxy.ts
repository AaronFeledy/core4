import { Schema } from "effect";

import { AbsolutePath } from "./primitives.ts";

/**
 * Host-proxy wire protocol request/response schemas.
 *
 * The host proxy is a per-app container→host RPC channel. These schemas are the
 * canonical request/response shapes exchanged over the channel. This module is
 * an internal SDK export: it is deliberately NOT registered in
 * `rawPublicSchemaRegistry` yet — the union is still growing and the socket
 * transport is a later wave, so publishing the JSON schema now would churn the
 * public-schema snapshot on every added variant. The `runLando` request and the
 * error response are the shapes exercised today by the `app:open` round-trip.
 */

/** Machine-readable host-proxy failure codes carried on an `error` response. */
export const HostProxyErrorCode = Schema.Literal(
  "command-not-allowed",
  "allowlist-conflict",
  "scheme-not-allowed",
  "recursion-limit",
  "backpressure",
  "token-mismatch",
  "internal",
);
export type HostProxyErrorCode = typeof HostProxyErrorCode.Type;

/** Env forwarded from the container, already filtered to the shim allowlist. */
const HostProxyEnv = Schema.Record({ key: Schema.String, value: Schema.String });

/**
 * `runLando` re-enters Lando's command runtime on the host. `argv` is the
 * canonical-id + args (subject to the generated host-proxy allowlist); `cwd` is
 * the container path the host dispatcher remaps to the host app root.
 */
export const HostProxyRunLandoRequest = Schema.TaggedStruct("runLando", {
  argv: Schema.Array(Schema.String),
  cwd: AbsolutePath,
  tty: Schema.Boolean,
  env: Schema.optional(HostProxyEnv),
});
export type HostProxyRunLandoRequest = typeof HostProxyRunLandoRequest.Type;

/**
 * Canonical host-proxy request union.
 *
 * Exactly four members: `runLando`, `openUrl`, `openPath`, `runBun`.
 * Container-initiated `notify`/`clipboardCopy` are unsupported (§10.10.2) and
 * deliberately absent — there is no deprecation shim.
 */
export const HostProxyRequest = Schema.Union(
  HostProxyRunLandoRequest,
  Schema.TaggedStruct("openUrl", {
    url: Schema.String,
    target: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct("openPath", {
    path: AbsolutePath,
  }),
  Schema.TaggedStruct("runBun", {
    argv: Schema.Array(Schema.String),
    cwd: AbsolutePath,
    tty: Schema.Boolean,
    env: Schema.optional(HostProxyEnv),
  }),
);
export type HostProxyRequest = typeof HostProxyRequest.Type;

/** Closed set of HostProxyRequest `_tag` values (schema-surface test seam). */
export const HOST_PROXY_REQUEST_TAGS = ["runLando", "openUrl", "openPath", "runBun"] as const;
export type HostProxyRequestTag = (typeof HOST_PROXY_REQUEST_TAGS)[number];

/** Canonical host-proxy response union. */
export const HostProxyResponse = Schema.Union(
  Schema.TaggedStruct("ok", { data: Schema.optional(Schema.Unknown) }),
  Schema.TaggedStruct("error", {
    code: HostProxyErrorCode,
    message: Schema.String,
    remediation: Schema.optional(Schema.String),
  }),
);
export type HostProxyResponse = typeof HostProxyResponse.Type;
