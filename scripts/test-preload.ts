/**
 * Bun latches proxy configuration from HTTP(S)_PROXY at fetch time and keeps
 * it after the env var is unset, so one test that exercises proxy env can
 * poison every later loopback request in the shared test process. Production
 * entries (`core/bin/lando.ts`, the host-proxy worker, the shim) install a
 * loopback NO_PROXY guard; this preload mirrors it for the test process.
 */
const entries = (process.env.NO_PROXY ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
for (const host of ["127.0.0.1", "localhost"]) {
  if (!entries.includes(host)) entries.push(host);
}
process.env.NO_PROXY = entries.join(",");
