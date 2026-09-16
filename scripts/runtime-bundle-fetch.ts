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

export const fetchOverHttps = async (
  url: string,
  options: FetchOverHttpsOptions = {},
): Promise<Uint8Array> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? RUNTIME_BUNDLE_FETCH_ATTEMPTS;
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
      if (attempt === attempts) throw cause;
    }
    if (attempt < attempts) await sleep(RUNTIME_BUNDLE_FETCH_RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  throw lastError ?? new RuntimeBundleDownloadError(url, 0);
};
