import { Context, type Effect, type Scope } from "effect";

import type {
  DownloadChecksumError,
  DownloadFetchError,
  DownloadOfflineError,
  DownloadPersistError,
  DownloadSizeMismatchError,
  DownloadSourceForbiddenError,
  DownloaderUnavailableError,
} from "../errors/index.ts";
import type { DownloadRequest, DownloadResult, DownloaderCapabilities } from "../schema/index.ts";

export type DownloadError =
  | DownloadFetchError
  | DownloadChecksumError
  | DownloadSizeMismatchError
  | DownloadPersistError
  | DownloadOfflineError
  | DownloadSourceForbiddenError
  | DownloaderUnavailableError;

export interface DownloaderShape {
  readonly id: string;
  readonly capabilities: DownloaderCapabilities;
  readonly download: (request: DownloadRequest) => Effect.Effect<DownloadResult, DownloadError, Scope.Scope>;
}

export class Downloader extends Context.Tag("@lando/core/Downloader")<Downloader, DownloaderShape>() {}
