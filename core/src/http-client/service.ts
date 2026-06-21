/**
 * Core-private provisional `HttpClient` tag.
 *
 * This is the single outbound-egress chokepoint that `Downloader` issues its
 * byte-fetch through, so overriding `HttpClient` governs downloads too. It is
 * intentionally NOT published from `@lando/sdk/services` and NOT re-exported
 * from `core/src/services/index.ts`. The full SDK `HttpClient` surface
 * (request/upload/capabilities, schemas, events, network-trust resolver, and
 * manifest contributions) is not published yet. This tag carries only the
 * streaming primitive downloads need today; the id `@lando/core/HttpClient` is
 * stable so promotion to the public SDK tag does not force consumer renames.
 *
 * Trust resolution (proxy/CA/`NO_PROXY`), lifecycle events, redaction, buffered
 * request/response, and upload deliberately live nowhere here.
 */
import { Context, Data, type Effect, type Scope, type Stream } from "effect";

/** Failure raised while opening a stream or pulling its body. Core-private. */
export class HttpStreamError extends Data.TaggedError("HttpStreamError")<{
  readonly message: string;
  readonly url: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/** A streaming byte-fetch request. */
export interface HttpStreamRequest {
  /** Single resolved artifact URL. */
  readonly url: string;
  /** Permit `file://` sources (local CI/dev artifacts). Defaults to `false`. */
  readonly allowFileSource?: boolean;
  /** Optional request headers. */
  readonly headers?: ReadonlyMap<string, string>;
}

/** A streaming byte-fetch response. The body is consumed within the scope that
 * the `stream` effect runs in. */
export interface HttpStreamResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  /** Non-buffering response body. */
  readonly body: Stream.Stream<Uint8Array, HttpStreamError>;
}

export interface HttpClientShape {
  readonly id: string;
  /** Open a non-buffering streaming byte-fetch. The connection lifetime is
   * bound to the ambient `Scope`. */
  readonly stream: (
    request: HttpStreamRequest,
  ) => Effect.Effect<HttpStreamResponse, HttpStreamError, Scope.Scope>;
}

export class HttpClient extends Context.Tag("@lando/core/HttpClient")<HttpClient, HttpClientShape>() {}
