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

export class Downloader extends Context.Service<
  Downloader,
  {
    readonly id: string;
    readonly capabilities: DownloaderCapabilities;
    readonly download: (
      request: DownloadRequest,
    ) => Effect.Effect<DownloadResult, DownloadError, Scope.Scope>;
  }
>()("@lando/core/Downloader") {}

export type DownloaderShape = Downloader["Service"];
