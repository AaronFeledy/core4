import { canonicalImageReference } from "@lando/sdk/schema";
import { Schema } from "effect";

export const DAY_MS = 24 * 60 * 60 * 1_000;
export const STALE_AFTER_DAYS = 90;
const LOOKUP_DEADLINE_MS = 12 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 8_000;
const ZERO_TIME_MS = Date.parse("0001-01-01T00:00:00Z");
const MANIFEST_ACCEPT =
  "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_ADDRESS =
  /^(?<registry>[\w.:-]+)\/(?<repository>[a-z0-9]+(?:[._/-]+[a-z0-9]+)*)(?::(?<tag>[\w][\w.-]*))?(?:@(?<digest>sha256:[a-f0-9]{64}))?$/u;

const asHubTimestamp = Schema.decodeUnknownOption(Schema.Struct({ last_updated: Schema.String }));
const asConfig = Schema.decodeUnknownOption(Schema.Struct({ created: Schema.String }));
const asManifest = Schema.decodeUnknownOption(
  Schema.Struct({ config: Schema.Struct({ digest: Schema.String.check(Schema.isPattern(DIGEST)) }) }),
);
const asIndex = Schema.decodeUnknownOption(
  Schema.Struct({
    manifests: Schema.Array(
      Schema.Struct({
        digest: Schema.String.check(Schema.isPattern(DIGEST)),
        platform: Schema.optionalKey(Schema.Struct({ os: Schema.String, architecture: Schema.String })),
      }),
    ),
  }),
);
const asToken = Schema.decodeUnknownOption(
  Schema.Struct({
    token: Schema.optionalKey(Schema.NonEmptyString),
    access_token: Schema.optionalKey(Schema.NonEmptyString),
  }),
);

export type TagLookup = {
  readonly tag: string;
} & (
  | {
      readonly verdict: "fresh" | "stale";
      readonly rebuiltAtMs: number;
      readonly source: "hub-last-updated" | "registry-config-created";
    }
  | { readonly verdict: "unknown"; readonly detail: string }
);

export type LookupOptions = {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly deadlineMs?: number;
};

const fetchRegistry = (url: string, init: RequestInit): Promise<Response> => fetch(url, init);

const bearerTokenUrl = (header: string | null): URL | undefined => {
  if (!header?.toLowerCase().startsWith("bearer ")) return undefined;
  const fields = new Map(
    Array.from(header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/gu), ([, key, quoted, bare]) => [
      key,
      quoted ?? bare,
    ]),
  );
  const realm = fields.get("realm");
  const url = realm === undefined ? null : URL.parse(realm);
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  for (const key of ["service", "scope"]) {
    const value = fields.get(key);
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url;
};

const readJson = (response: Response | undefined): Promise<unknown> | undefined =>
  response?.ok ? response.json().catch(() => undefined) : undefined;

export const makeStockArtifactLookup = (options: LookupOptions = {}) => {
  const fetchImage = options.fetch ?? fetchRegistry;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const deadline = options.deadlineMs ?? startedAt + LOOKUP_DEADLINE_MS;
  const tokens = new Map<string, string>();

  const request = async (url: string, headers?: Headers): Promise<Response | undefined> => {
    // One retry on transport errors, rate limiting, or 5xx; each request fits the shared budget.
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) return undefined;
      const response = await fetchImage(url, {
        ...(headers === undefined ? {} : { headers }),
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
      }).catch(() => undefined);
      if (attempt === 1 || (response !== undefined && response.status !== 429 && response.status < 500)) {
        return response;
      }
      const retryAfter = response?.headers.get("retry-after");
      const delay =
        retryAfter != null && /^\d+$/u.test(retryAfter)
          ? Math.min(Number(retryAfter) * 1_000, 60_000)
          : 1_000;
      if (response?.body) await response.body.cancel().catch(() => undefined);
      await sleep(Math.max(0, Math.min(delay, deadline - now())));
    }
    return undefined;
  };

  return async (ref: string): Promise<TagLookup> => {
    const unknown = (detail: string): TagLookup => ({
      tag: ref,
      verdict: "unknown",
      detail: now() >= deadline ? "lookup budget exhausted" : detail,
    });
    const dated = (timestamp: string | undefined, source: "hub-last-updated" | "registry-config-created") => {
      const rebuiltAtMs = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
      if (!Number.isFinite(rebuiltAtMs) || rebuiltAtMs <= ZERO_TIME_MS) {
        return unknown(
          source === "hub-last-updated" ? "Docker Hub last_updated missing" : "image config created missing",
        );
      }
      return {
        tag: ref,
        rebuiltAtMs,
        verdict: startedAt - rebuiltAtMs > STALE_AFTER_DAYS * DAY_MS ? "stale" : "fresh",
        source,
      } satisfies TagLookup;
    };
    if (now() >= deadline) return unknown("lookup budget exhausted");
    const { registry, repository, tag, digest } =
      IMAGE_ADDRESS.exec(canonicalImageReference(ref))?.groups ?? {};
    const target = digest ?? tag;
    if (registry === undefined || repository === undefined || target === undefined) {
      return unknown("unparseable image reference");
    }
    if (registry === "docker.io" && digest === undefined) {
      const response = await request(
        `https://hub.docker.com/v2/repositories/${repository}/tags/${encodeURIComponent(target)}`,
      );
      if (response === undefined) return unknown("Docker Hub lookup failed");
      if (!response.ok) return unknown(`Docker Hub HTTP ${response.status}`);
      const timestamp = asHubTimestamp(await readJson(response));
      return dated(timestamp._tag === "Some" ? timestamp.value.last_updated : undefined, "hub-last-updated");
    }

    const host = registry === "docker.io" ? "registry-1.docker.io" : registry;
    const base = `https://${host}/v2/${repository}`;
    const get = async (path: string): Promise<unknown> => {
      const url = `${base}/${path}`;
      const headers = new Headers({ Accept: MANIFEST_ACCEPT });
      const token = tokens.get(base);
      if (token !== undefined) headers.set("Authorization", `Bearer ${token}`);
      const response = await request(url, headers);
      if (response?.status !== 401) return readJson(response);
      const tokenUrl = bearerTokenUrl(response.headers.get("www-authenticate"));
      if (tokenUrl === undefined) return undefined;
      const decoded = asToken(await readJson(await request(tokenUrl.href)));
      const authorized =
        decoded._tag === "Some" ? (decoded.value.token ?? decoded.value.access_token) : undefined;
      if (authorized === undefined) return undefined;
      tokens.set(base, authorized);
      headers.set("Authorization", `Bearer ${authorized}`);
      return readJson(await request(url, headers));
    };
    const manifestUrl = (reference: string) =>
      `manifests/${DIGEST.test(reference) ? reference : encodeURIComponent(reference)}`;
    const body = await get(manifestUrl(target));
    let manifest = asManifest(body);
    if (manifest._tag === "None") {
      const index = asIndex(body);
      if (index._tag === "Some") {
        const linux = index.value.manifests.filter(({ platform }) => platform?.os === "linux");
        const child = linux.find(({ platform }) => platform?.architecture === "amd64") ?? linux[0];
        if (child !== undefined) manifest = asManifest(await get(manifestUrl(child.digest)));
      }
    }
    if (manifest._tag === "None") return unknown("registry config digest missing");
    const config = asConfig(await get(`blobs/${manifest.value.config.digest}`));
    return dated(config._tag === "Some" ? config.value.created : undefined, "registry-config-created");
  };
};
