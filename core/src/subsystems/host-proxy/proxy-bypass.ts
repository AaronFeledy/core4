const PROXY_ENV_NAMES = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] as const;

export const ensureHostProxyNoProxy = (targetHost: string, env: NodeJS.ProcessEnv = process.env): void => {
  const proxyConfigured = PROXY_ENV_NAMES.some((name) => env[name] !== undefined);
  if (!proxyConfigured) return;
  const current = env.NO_PROXY ?? env.no_proxy ?? "";
  const entries = current
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.includes("*") || entries.includes(targetHost)) return;
  entries.push(targetHost);
  env.NO_PROXY = entries.join(",");
};
