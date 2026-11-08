import { expect, test } from "bun:test";

import { landoErrorPageBytes } from "../../src/services/http-errors.ts";
import { HIDDEN_PATH_MARKER, WELL_KNOWN_ASSET } from "./http-error-pages-cases.ts";
import type { ErrorPageServer, ErrorPageStack } from "./http-error-pages-live.ts";

export const apacheRewriteFixture = [
  "RewriteEngine On",
  "RewriteRule ^up$ index.php [L]",
  "RewriteRule ^scheme-rewritten$ scheme.php [L]",
  "RewriteRule ^wp-admin$ wp-admin/ [R=301,L]",
  "",
].join("\n");

export const registerWebDefaultsCases = (server: ErrorPageServer, getStack: () => ErrorPageStack): void => {
  const apache = server.startsWith("apache");
  const php = server !== "static" && server !== "nginx" && server !== "apache-static";
  for (const path of [
    "/.env",
    "/%2eenv",
    "/.git/config",
    "/.HTPASSWD",
    "/nested/.env",
    "/.well-known-extra/secret.txt",
    "/.well-known/.env",
    ...(php ? ["/.hidden/x.php", "/%2ehidden/x.php"] : []),
    ...(server === "apache" || server === "apache-port" || server === "apache-upload-dirs"
      ? ["/.htaccess"]
      : []),
  ]) {
    test(`denies hidden path ${path}`, async () => {
      const stack = getStack();
      const response = await stack.request(`${stack.baseUrl}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      expect(response.status).toBe(403);
      expect(body).not.toContain(HIDDEN_PATH_MARKER);
      if (server !== "apache-static") expect(body).toBe(landoErrorPageBytes(403));
    });
  }
  test("serves the well-known exception", async () => {
    const stack = getStack();
    const response = await stack.request(`${stack.baseUrl}/.well-known/ok.txt`, {
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(WELL_KNOWN_ASSET);
  });
  // A port-less Host on forwarded http catches a redirect that leaks Apache's own listener port.
  const requests = [
    { host: "x.lndo.site:8443", forwarded: "https" },
    { host: "x.lndo.site", forwarded: "http" },
    { host: "x.lndo.site", forwarded: undefined },
  ] as const;
  for (const path of ["/noindex", "/noindex?a=1"]) {
    for (const { host, forwarded } of requests) {
      test(`directory redirect keeps the public URL for ${path}, host=${host}, proto=${forwarded}`, async () => {
        const stack = getStack();
        const response = await stack.request(`${stack.baseUrl}${path}`, {
          headers: { Host: host, ...(forwarded === undefined ? {} : { "X-Forwarded-Proto": forwarded }) },
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        const target = path.replace("/noindex", "/noindex/");
        expect(response.status).toBe(301);
        if (!apache) {
          expect(response.headers.get("location")).toBe(target);
        } else if (forwarded === undefined) {
          expect(response.headers.get("location")).toStartWith("http://");
        } else {
          expect(response.headers.get("location")).toBe(`${forwarded}://${host}${target}`);
        }
      });
    }
  }

  if (server !== "apache" && server !== "apache-port" && server !== "nginx-fpm") return;

  for (const forwarded of [undefined, "http", "https"]) {
    for (const path of apache ? ["/scheme.php", "/scheme-rewritten"] : ["/scheme.php"]) {
      test(`PHP reports the router scheme for ${path}, proto=${forwarded}`, async () => {
        const stack = getStack();
        const response = await stack.request(`${stack.baseUrl}${path}`, {
          headers: forwarded === undefined ? {} : { "X-Forwarded-Proto": forwarded },
          signal: AbortSignal.timeout(15_000),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(forwarded === "https" ? "HTTPS=on" : "HTTPS=");
      });
    }
  }

  for (const path of ["/secret.PHP", "/mixed.Php", "/.PHP", "/dir/.PhP", "/control.php"]) {
    test(`PHP extension casing cannot expose source at ${path}`, async () => {
      const stack = getStack();
      const response = await stack.request(`${stack.baseUrl}${path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.text();
      const control = path === "/control.php";
      expect(response.status).toBe(control ? 200 : 403);
      expect(body).toBe(control ? "CASE_EXECUTED" : landoErrorPageBytes(403));
      expect(body).not.toContain("case-source-marker");
    });
  }

  if (!apache) return;
  test("HTTPS directory redirect takes precedence over multisite htaccess rules", async () => {
    const stack = getStack();
    const response = await stack.request(`${stack.baseUrl}/wp-admin`, {
      headers: { Host: "x.lndo.site:8443", "X-Forwarded-Proto": "https" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://x.lndo.site:8443/wp-admin/");
  });
};
