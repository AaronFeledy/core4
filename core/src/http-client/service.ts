/**
 * Core-private re-export of the canonical `@lando/sdk` `HttpClient` contract.
 *
 * `HttpClient` is the single outbound-egress chokepoint every Lando-owned fetch
 * issues through (`Downloader`, `lando setup` preflight, tool provisioning), so
 * overriding `HttpClient` governs all egress. The tag, its `{ id, capabilities,
 * request, stream, upload }` shape, the request/response/upload schemas, and the
 * tagged errors live in `@lando/sdk`; core implements `HttpClientLive` against
 * that contract. This module re-exports the
 * SDK contract so core-internal callers have a stable import path and do not
 * reach across the SDK boundary directly.
 */
export {
  type HttpClientError,
  type HttpClientShape,
  HttpClient,
} from "@lando/sdk/services";
export type {
  HttpClientCapabilities,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpUploadRequest,
} from "@lando/sdk/schema";
export {
  HttpClientUnavailableError,
  HttpRequestError,
  HttpTrustError,
  HttpUploadError,
} from "@lando/sdk/errors";
