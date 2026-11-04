import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResolvedNetworkTrust, shouldBypassProxy } from "@lando/sdk/network-trust";
import { createRedactor } from "@lando/sdk/secrets";

export interface GitTransportOptions {
  readonly trust?: ResolvedNetworkTrust | (() => Promise<ResolvedNetworkTrust | undefined>);
  readonly systemCaPems: () => readonly string[];
}

export interface GitNetworkProjection {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly redact?: (message: string) => string;
}

/** SSH and scp-style URLs retain SSH's own configuration; HTTP trust is not projected. */
export const withGitTrust = async <A>(
  url: string,
  options: GitTransportOptions,
  use: (projection: GitNetworkProjection) => Promise<A>,
): Promise<A> => {
  if (!/^https?:\/\//iu.test(url)) return use({ args: [], env: {} });
  const trust = typeof options.trust === "function" ? await options.trust() : options.trust;
  if (trust === undefined) return use({ args: [], env: {} });
  const system = options.systemCaPems();
  const proxy = shouldBypassProxy(url, trust.proxy.noProxy)
    ? ""
    : ((new URL(url).protocol === "https:" ? trust.proxy.https : trust.proxy.http) ?? "");
  const args = ["-c", `http.proxy=${proxy}`];
  const credentials: string[] = [];
  for (const proxyUrl of [trust.proxy.http, trust.proxy.https]) {
    if (proxyUrl === undefined || proxyUrl === "") continue;
    const parsed = new URL(proxyUrl);
    for (const value of [parsed.username, parsed.password]) {
      if (value === "") continue;
      credentials.push(value);
      try {
        credentials.push(decodeURIComponent(value));
      } catch (cause) {
        if (!(cause instanceof URIError)) throw cause;
      }
    }
  }
  const redact = createRedactor("secrets", {
    values: credentials,
    authoritativeValues: credentials,
  }).redactString;
  // libcurl must not reinterpret inherited NO_PROXY after Lando has decided.
  const env = { NO_PROXY: "", no_proxy: "" };
  if (trust.caPems.length === 0 && trust.trustHost && (process.platform !== "win32" || system.length === 0))
    return use({ args, env, redact });
  const temp = await mkdtemp(join(tmpdir(), "lando-git-trust-"));
  try {
    const bundle = join(temp, "ca.pem");
    const pems = trust.trustHost ? [...system, ...trust.caPems] : trust.caPems;
    await writeFile(bundle, pems.join("\n"), { mode: 0o600 });
    // Git for Windows' schannel backend ignores sslCAInfo unless told otherwise.
    const schannel = process.platform === "win32" ? ["-c", "http.schannelUseSSLCAInfo=true"] : [];
    return await use({ args: [...args, "-c", `http.sslCAInfo=${bundle}`, ...schannel], env, redact });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};
