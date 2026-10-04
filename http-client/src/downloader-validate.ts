/**
 * Source/destination guards for the verified-artifact Downloader.
 */
import { DownloadSourceForbiddenError } from "@lando/sdk/errors";
import type { DownloadRequest } from "@lando/sdk/schema";

/** Redacted scheme+host origin only — never userinfo, path, or query. */
export const urlOrigin = (url: string): string => {
  try {
    const parsed = new URL(url);
    return parsed.host.length > 0 ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "unknown";
  }
};

export const validateSource = (request: DownloadRequest): DownloadSourceForbiddenError | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return new DownloadSourceForbiddenError({
      message: "The download URL is not a valid absolute URL.",
      url: request.url,
      reason: "scheme",
    });
  }
  if (parsed.protocol === "https:") return undefined;
  if (parsed.protocol === "file:") {
    if (request.allowFileSource === true) return undefined;
    return new DownloadSourceForbiddenError({
      message: "file:// sources are rejected unless the request explicitly allows local sources.",
      url: request.url,
      reason: "file-source",
    });
  }
  return new DownloadSourceForbiddenError({
    message: `The scheme ${parsed.protocol} is not allowed; https:// is the only production scheme.`,
    url: request.url,
    reason: "scheme",
  });
};

export const validateDestinationFilename = (filename: string): DownloadSourceForbiddenError | undefined => {
  if (
    filename.length === 0 ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    filename === "." ||
    filename === ".."
  ) {
    return new DownloadSourceForbiddenError({
      message: "The destination filename must be a single path segment within the target directory.",
      reason: "destination-escape",
    });
  }
  return undefined;
};
