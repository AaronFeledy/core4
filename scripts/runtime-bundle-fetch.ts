export const RUNTIME_BUNDLE_FETCH_ATTEMPTS = 4;
export const RUNTIME_BUNDLE_FETCH_RETRY_BASE_MS = 250;

export type FetchImpl = (url: string) => Promise<Response>;

export interface FetchOverHttpsOptions {
  readonly fetchImpl?: FetchImpl;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
}

export class RuntimeBundleDownloadError extends Error {
  override readonly name = "RuntimeBundleDownloadError";

  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`assemble-runtime-bundle: download failed (${status}) for ${url}`);
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const DEBIAN_METADATA_COPYRIGHT =
  /^https:\/\/metadata\.ftp-master\.debian\.org\/changelogs\/([^/]+)\/([^/]+)\/([^/]+)\/\3_(.+)_copyright$/u;

/**
 * ftp-master only keeps the current point-release changelog/copyright. When Debian
 * rotates that file, the pinned URL 404s even though sources.debian.org still
 * serves debian/copyright for the exact version.
 */
export const debianMetadataCopyrightFallbacks = (url: string): readonly string[] => {
  const match = DEBIAN_METADATA_COPYRIGHT.exec(url);
  const section = match?.[1];
  const prefix = match?.[2];
  const source = match?.[3];
  const version = match?.[4];
  if (section === undefined || prefix === undefined || source === undefined || version === undefined) {
    return [];
  }
  return [
    `https://sources.debian.org/data/${section}/${prefix}/${source}/${encodeURIComponent(version)}/debian/copyright`,
  ];
};

const fetchUrlOverHttps = async (
  url: string,
  options: {
    readonly fetchImpl: FetchImpl;
    readonly sleep: (ms: number) => Promise<void>;
    readonly attempts: number;
  },
): Promise<Uint8Array> => {
  const { fetchImpl, sleep, attempts } = options;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      const error = new RuntimeBundleDownloadError(url, response.status);
      if (!isRetryableStatus(response.status) || attempt === attempts) throw error;
      lastError = error;
    } catch (cause) {
      if (cause instanceof RuntimeBundleDownloadError && !isRetryableStatus(cause.status)) throw cause;
      if (!(cause instanceof Error)) throw cause;
      lastError = cause;
      if (attempt === attempts) {
        if (cause instanceof RuntimeBundleDownloadError) throw cause;
        throw new Error(`assemble-runtime-bundle: download failed for ${url}: ${cause.message}`, { cause });
      }
    }
    if (attempt < attempts) await sleep(RUNTIME_BUNDLE_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  throw lastError ?? new RuntimeBundleDownloadError(url, 0);
};

export const fetchOverHttps = async (
  url: string,
  options: FetchOverHttpsOptions = {},
): Promise<Uint8Array> => {
  const resolved = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? defaultSleep,
    attempts: options.attempts ?? RUNTIME_BUNDLE_FETCH_ATTEMPTS,
  };
  try {
    return await fetchUrlOverHttps(url, resolved);
  } catch (cause) {
    if (!(cause instanceof RuntimeBundleDownloadError) || cause.status !== 404) throw cause;
    for (const fallback of debianMetadataCopyrightFallbacks(url)) {
      try {
        return await fetchUrlOverHttps(fallback, resolved);
      } catch (fallbackCause) {
        if (fallbackCause instanceof RuntimeBundleDownloadError && fallbackCause.status === 404) continue;
        throw fallbackCause;
      }
    }
    throw cause;
  }
};
