import { Context, type Effect, type Scope, type Stream } from "effect";

import type {
  HttpClientUnavailableError,
  HttpRequestError,
  HttpTrustError,
  HttpUploadError,
} from "../errors/index.ts";
import type {
  HttpClientCapabilities,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  HttpUploadRequest,
} from "../schema/index.ts";

export type HttpClientError =
  | HttpRequestError
  | HttpUploadError
  | HttpTrustError
  | HttpClientUnavailableError;

export interface HttpClientShape {
  readonly id: string;
  readonly capabilities: HttpClientCapabilities;
  readonly request: (
    req: HttpRequest,
  ) => Effect.Effect<
    HttpResponse,
    HttpRequestError | HttpTrustError | HttpClientUnavailableError,
    Scope.Scope
  >;
  readonly stream: (
    req: HttpRequest,
  ) => Effect.Effect<
    HttpStreamResponse & { readonly body: Stream.Stream<Uint8Array, HttpRequestError | HttpTrustError> },
    HttpRequestError | HttpTrustError | HttpClientUnavailableError,
    Scope.Scope
  >;
  readonly upload: (
    req: HttpUploadRequest,
  ) => Effect.Effect<
    HttpResponse,
    HttpUploadError | HttpTrustError | HttpClientUnavailableError,
    Scope.Scope
  >;
}

export class HttpClient extends Context.Tag("@lando/core/HttpClient")<HttpClient, HttpClientShape>() {}
