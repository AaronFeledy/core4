import { expect, test } from "bun:test";

import { landoErrorPageBytes } from "../../src/services/http-errors.ts";
import { HIDDEN_PATH_MARKER, WELL_KNOWN_ASSET, publicSchemeResponse } from "./http-error-pages-cases.ts";
import type { ErrorPageServer, ErrorPageStack } from "./http-error-pages-live.ts";

export const apacheRewriteFixture = [
  "RewriteEngine On",
  "RewriteRule ^up$ index.php [L]",
  "RewriteRule ^scheme-rewritten$ scheme.php [L]",
  "RewriteRule ^wp-admin$ wp-admin/ [R=301,L]",
  "",
].join("\n");

const directoryRedirectStatus = (server: ErrorPageServer): number => (server === "caddy" ? 308 : 301);

export const registerWebDefaultsCases = (server: ErrorPageServer, getStack: () => ErrorPageStack): void => {
  const apache = server.startsWith("apache");
  // Name the servers that actually execute PHP; a generated file server is not PHP.
  const php = ["apache", "apache-port", "apache-upload-dirs", "nginx-fpm", "nginx-fpm-upload-dirs"].includes(
    server,
  );
  // Apache static has its own error document handling; every other generated server shares Lando's pages.
  const sharedErrorPage = server !== "apache-static";
  for (const path of [
    "/.env",
    "/%2eenv",
    "/.git/config",
    "/.HTPASSWD",
    "/nested/.env",
    "/.well-known-extra/secret.txt",
    "/.well-known/.env",
    "/.git/.well-known/x",
    "/a/.well-known/.git/config",
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
      if (sharedErrorPage) expect(body).toBe(landoErrorPageBytes(403));
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
  // A port-less Host on forwarded http catches a redirect that leaks the server's own listener port.
  const requests = [
    { host: "x.lndo.site:8443", forwarded: "https" },
    { host: "x.lndo.site", forwarded: "http" },
    { host: "x.lndo.site", forwarded: undefined },
  ] as const;
  // Caddy only redirects a directory it can index; nginx redirects any directory.
  const redirectBase = server === "caddy" ? "/section" : "/noindex";
  for (const path of [redirectBase, `${redirectBase}?a=1`]) {
    for (const { host, forwarded } of requests) {
      test(`directory redirect keeps the public URL for ${path}, host=${host}, proto=${forwarded}`, async () => {
        const stack = getStack();
        const response = await stack.request(`${stack.baseUrl}${path}`, {
          headers: { Host: host, ...(forwarded === undefined ? {} : { "X-Forwarded-Proto": forwarded }) },
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        await response.body?.cancel();
        const target = path.replace(redirectBase, `${redirectBase}/`);
        // Caddy's canonical directory redirect is a relative 308; nginx uses a relative 301.
        expect(response.status).toBe(directoryRedirectStatus(server));
        if (!apache) {
          expect(response.headers.get("location")).toBe(target);
        } else {
          // The plain listener keeps Host authority and the public query, but the
          // connection scheme is genuinely http: native TLS is the only shape that
          // yields https here.
          expect(response.headers.get("location")).toBe(`http://${host}${target}`);
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

  if (server === "nginx-fpm") {
    // Direct plain requests use nginx's own scheme and listener port; the router's
    // X-Forwarded-Proto/X-Forwarded-Port replace them only when they are valid.
    const scenarios = [
      {
        label: "a direct plain request",
        headers: {},
        expected: publicSchemeResponse("", "http", "80"),
      },
      {
        label: "forwarded https on 443",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "443" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "forwarded https on 8443",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "8443" },
        expected: publicSchemeResponse("on", "https", "8443"),
      },
      {
        label: "forwarded https without a port",
        headers: { "X-Forwarded-Proto": "https" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "forwarded http on 8080",
        headers: { "X-Forwarded-Proto": "http", "X-Forwarded-Port": "8080" },
        expected: publicSchemeResponse("", "http", "8080"),
      },
      {
        label: "forwarded http without a port",
        headers: { "X-Forwarded-Proto": "http" },
        expected: publicSchemeResponse("", "http", "80"),
      },
      {
        label: "a comma-separated forwarded port",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "443, 8443" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "an out-of-range forwarded port",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "65536" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "a leading-zero forwarded port",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "065535" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "an empty forwarded port",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "a non-numeric forwarded port",
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Port": "https" },
        expected: publicSchemeResponse("on", "https", "443"),
      },
      {
        label: "an unknown forwarded scheme",
        headers: { "X-Forwarded-Proto": "ftp" },
        expected: publicSchemeResponse("", "http", "80"),
      },
    ] as const;
    for (const scenario of scenarios) {
      test(`nginx projects ${scenario.label} to PHP`, async () => {
        const stack = getStack();
        const response = await stack.request(`${stack.baseUrl}/public-scheme.php`, {
          headers: scenario.headers,
          signal: AbortSignal.timeout(15_000),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(scenario.expected);
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
};
