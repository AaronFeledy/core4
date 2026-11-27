import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import {
  binary,
  cli,
  decodeStart,
  infoEnvelope,
  liveProvider,
  managedLinuxMapsProjectUser,
  mkcertRootCertificatePath,
  prerequisite,
  run,
} from "./route-cli-live-support.ts";

interface RequestOptions {
  /** Host header override, for the port-less and fallback authority shapes. */
  readonly host?: string;
  readonly headers?: readonly string[];
  readonly caPath?: string;
}

const request = async (root: string, url: URL, options: RequestOptions = {}) => {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const response = await run(
    root,
    [
      "curl",
      "--silent",
      "--show-error",
      "--noproxy",
      "*",
      "--connect-timeout",
      "3",
      "--max-time",
      "5",
      "--resolve",
      `${url.hostname}:${port}:127.0.0.1`,
      "--header",
      `Host: ${options.host ?? url.host}`,
      ...(options.headers ?? []).flatMap((header) => ["--header", header]),
      ...(url.protocol === "https:" && options.caPath !== undefined
        ? ["--cacert", options.caPath]
        : ["--insecure"]),
      // Raw Location preserves relative redirects; redirect_url would expand them.
      "--dump-header",
      "-",
      "--write-out",
      "\n%{http_code}",
      url.href,
    ],
    30_000,
  );
  const boundary = response.indexOf("\r\n\r\n");
  expect(boundary, response).toBeGreaterThan(-1);
  const statusAt = response.lastIndexOf("\n");
  return {
    status: Number(response.slice(statusAt + 1)),
    body: response.slice(boundary + 4, statusAt),
    location: response.slice(0, boundary).match(/^location:\s*(.*?)\r?$/imu)?.[1],
  };
};

describe.serial("compiled CLI managed PHP routing", () => {
  test.skipIf(prerequisite !== undefined && process.env.LANDO_GUIDE_E2E !== "1")(
    "serves native Apache TLS and nginx public scheme with port-correct redirects",
    async () => {
      if (prerequisite !== undefined) throw new Error(prerequisite);
      const caPath = await mkcertRootCertificatePath();
      if (caPath === undefined) throw new Error("The inherited roots have no installed mkcert root.");
      // Given: an installed managed router plus Apache and nginx/FPM in one isolated app.
      const root = await mkdtemp(join(tmpdir(), "lando-php-route-cli-"));
      const name = `php-route-cli-${crypto.randomUUID()}`;
      const secret = `env-secret-${crypto.randomUUID()}`;
      const source = `php-source-${crypto.randomUUID()}`;
      try {
        const global = Schema.decodeUnknownSync(infoEnvelope)(await cli(root, ["global:info"])).result;
        expect(
          global.services.find((service) => service.service === "traefik"),
          `The inherited roots must contain the installed managed global Traefik app; this test never runs setup. Provider: ${liveProvider}.`,
        ).toMatchObject({ provider: "lando" });
        const privateFiles = liveProvider === "lando" && (await managedLinuxMapsProjectUser());
        const directoryMode = privateFiles ? 0o700 : 0o755;
        if (!privateFiles && process.platform !== "win32") await chmod(root, directoryMode);
        await mkdir(join(root, "sub"), { mode: directoryMode });
        await mkdir(join(root, "appdir"), { mode: directoryMode });
        await mkdir(join(root, "force"), { mode: directoryMode });
        const schemePhp = [
          "<?php",
          "header('Content-Type: application/json');",
          "echo json_encode([",
          "  'https' => $_SERVER['HTTPS'] ?? '',",
          "  'request_scheme' => $_SERVER['REQUEST_SCHEME'] ?? '',",
          "  'server_port' => $_SERVER['SERVER_PORT'] ?? '',",
          "  'server_name' => $_SERVER['SERVER_NAME'] ?? '',",
          "  'http_host' => $_SERVER['HTTP_HOST'] ?? '',",
          "]);",
          "",
        ].join("\n");
        const htaccess = [
          "RewriteEngine On",
          // mod_rewrite skips a slashless directory unless the app opts in, so the
          // app's own directory rewrite below can run instead of mod_dir.
          "RewriteOptions AllowNoSlash",
          // A relative target must keep the client's public scheme, host, and port.
          "RewriteRule ^old$ /rel/new [R=302,L]",
          // An app-owned rewrite of a slashless directory request.
          "RewriteRule ^appdir$ appdir/index.php [L]",
          "",
        ].join("\n");
        // The production force-HTTPS rule lives in its own directory so the plain
        // listener probe stays reachable over HTTP. Native TLS already sets
        // HTTPS, so it must not redirect an HTTPS request; on HTTP the app-authored
        // target uses HTTP_HOST exactly as the client sent it.
        const forceHtaccess = [
          "RewriteEngine On",
          "RewriteCond %{HTTPS} off",
          "RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]",
          "",
        ].join("\n");
        const files = {
          "scheme.php": schemePhp,
          "sub/asset.txt": name,
          ".htaccess": htaccess,
          "force/.htaccess": forceHtaccess,
          "force/scheme.php": schemePhp,
          "sub/index.php": "<?php echo 'sub-index';\n",
          "appdir/.htaccess": "DirectorySlash Off\n",
          "appdir/index.php": "<?php echo 'app-dir-index';\n",
          ".env": secret,
          "secret.PHP": `<?php echo strrev('${source}');\n`,
          ".lando.yml": [
            `name: ${name}`,
            "runtime: 4",
            `provider: ${liveProvider}`,
            "services:",
            "  appserver:",
            '    type: "php:8.3"',
            "    primary: true",
            "    allowOverride: true",
            "    routes:",
            `      - hostname: ${name}.lndo.site`,
            "        scheme: both",
            "  fpm:",
            '    type: "php:8.3"',
            "    via: fpm",
            "  edge:",
            "    type: nginx",
            "    backend: fpm",
            "    routes:",
            `      - hostname: edge-${name}.lndo.site`,
            "        scheme: both",
            "",
          ].join("\n"),
        };
        for (const [path, bytes] of Object.entries(files)) {
          await Bun.write(join(root, path), bytes);
          if (process.platform !== "win32") await chmod(join(root, path), privateFiles ? 0o600 : 0o644);
        }
        const routeUrl = (
          service:
            | {
                readonly connections: ReadonlyArray<{
                  source: string;
                  binding: string;
                  host?: string;
                  url?: string;
                }>;
              }
            | undefined,
          scheme: "http" | "https",
          hostname: string,
        ) => {
          const connection = service?.connections.find(
            (connection) =>
              connection.source === "route" &&
              connection.binding === "assigned" &&
              connection.host === hostname &&
              connection.url?.startsWith(`${scheme}://`),
          );
          if (connection?.url === undefined)
            throw new Error(`start published no ${scheme} route for ${hostname}`);
          return new URL(connection.url);
        };
        try {
          // When: the real compiled CLI plans and starts both generated server configurations.
          await cli(root, ["app:cache:refresh"]);
          const startAt = performance.now();
          const started = decodeStart(await cli(root, ["start"], 720_000));
          const startMs = performance.now() - startAt;
          const evidence: unknown[] = [];
          for (const [serviceName, hostname] of [
            ["appserver", `${name}.lndo.site`],
            ["edge", `edge-${name}.lndo.site`],
          ] as const) {
            const service = started.servicesStarted.find((item) => item.name === serviceName);
            const httpsUrl = routeUrl(service, "https", hostname);
            const httpUrl = routeUrl(service, "http", hostname);
            const httpsPort = Number(httpsUrl.port || 443);
            const httpPort = Number(httpUrl.port || 80);
            // Then: the public scheme and port are real, not header-derived.
            const secure = await request(root, new URL("/scheme.php", httpsUrl), { caPath });
            const insecure = await request(root, new URL("/scheme.php", httpUrl), { caPath });
            for (const [label, response, expected] of [
              ["https", secure, { https: "on", scheme: "https", port: String(httpsPort) }],
              ["http", insecure, { https: "", scheme: "http", port: String(httpPort) }],
            ] as const) {
              expect(response.status, `${serviceName} ${label} scheme.php: ${response.body}`).toBe(200);
              const values = JSON.parse(response.body) as Record<string, string>;
              expect(values.https, `${serviceName} ${label} HTTPS`).toBe(expected.https);
              expect(values.request_scheme, `${serviceName} ${label} REQUEST_SCHEME`).toBe(expected.scheme);
              expect(values.server_port, `${serviceName} ${label} SERVER_PORT`).toBe(expected.port);
              expect(values.server_name, `${serviceName} ${label} SERVER_NAME`).toBe(hostname);
              expect(values.http_host, `${serviceName} ${label} HTTP_HOST`).toBe(
                label === "https" ? httpsUrl.host : httpUrl.host,
              );
            }
            // A port-less Host over the TLS ingress is the 443 public shape even
            // when the router's concrete port is a fallback.
            const portless = await request(root, new URL("/scheme.php", httpsUrl), {
              caPath,
              host: hostname,
            });
            expect(JSON.parse(portless.body)).toMatchObject({
              https: "on",
              request_scheme: "https",
              server_port: "443",
              server_name: hostname,
              http_host: hostname,
            });
            // A Host carrying the public port keeps it.
            const withPort = await request(root, new URL("/scheme.php", httpsUrl), {
              caPath,
              host: `${hostname}:${httpsPort}`,
            });
            expect(JSON.parse(withPort.body)).toMatchObject({
              server_port: String(httpsPort),
              http_host: `${hostname}:${httpsPort}`,
            });
            const redirect = await request(root, new URL("/sub", httpsUrl), { caPath });
            expect(redirect.status, `${serviceName} /sub`).toBe(301);
            expect(redirect.location).toBe(
              serviceName === "appserver" ? new URL("/sub/", httpsUrl).href : "/sub/",
            );
            evidence.push({
              service: serviceName,
              https: httpsUrl.href,
              http: httpUrl.href,
              secure: JSON.parse(secure.body),
              insecure: JSON.parse(insecure.body),
              redirect,
            });
            if (serviceName === "edge") {
              const asset = await request(root, new URL("/sub/asset.txt", httpsUrl), { caPath });
              expect(asset).toMatchObject({ status: 200, body: name });
              const missingScript = await request(root, new URL("/missing.php", httpsUrl), { caPath });
              expect(missingScript.status).toBe(404);
              evidence.push({ assetStatus: asset.status, missingScriptStatus: missingScript.status });
              // Router ingress replaces a spoofed client protocol header.
              const spoofed = await request(root, new URL("/scheme.php", httpUrl), {
                caPath,
                headers: ["X-Forwarded-Proto: https", `X-Forwarded-Port: ${httpsPort}`],
              });
              expect(JSON.parse(spoofed.body)).toMatchObject({
                https: "",
                request_scheme: "http",
                server_port: String(httpPort),
              });
            } else {
              for (const [path, marker] of [
                ["/.env", secret],
                ["/secret.PHP", source],
              ] as const) {
                const denied = await request(root, new URL(path, httpsUrl), { caPath });
                expect(denied.status, `${serviceName} ${path}`).toBe(403);
                expect(denied.body).not.toContain(marker);
              }
              // The production force-HTTPS rule must not redirect HTTPS.
              const forceSecure = await request(root, new URL("/force/scheme.php", httpsUrl), {
                caPath,
              });
              expect(forceSecure.status, `${serviceName} force-HTTPS on HTTPS`).toBe(200);
              expect(forceSecure.location).toBeUndefined();
              // On HTTP it redirects once, with the app's own HTTP_HOST authority.
              const forceInsecure = await request(root, new URL("/force/scheme.php", httpUrl), {
                caPath,
                host: `${hostname}:${httpPort}`,
              });
              expect(forceInsecure.status, `${serviceName} force-HTTPS on HTTP`).toBe(301);
              expect(forceInsecure.location).toBe(`https://${hostname}:${httpPort}/force/scheme.php`);
              // A relative [R] keeps that authority on both schemes.
              const relativeSecure = await request(root, new URL("/old", httpsUrl), { caPath });
              expect(relativeSecure.status, `${serviceName} relative [R] HTTPS`).toBe(302);
              expect(relativeSecure.location).toBe(new URL("/rel/new", httpsUrl).href);
              // mod_dir keeps the public authority and preserves the query.
              const query = await request(root, new URL("/sub?x=1", httpsUrl), { caPath });
              expect(query.status, `${serviceName} /sub?x=1`).toBe(301);
              expect(query.location).toBe(new URL("/sub/?x=1", httpsUrl).href);
              // A directory with its own rewrite returns the app's target, not a
              // Lando-injected directory redirect.
              const appDir = await request(root, new URL("/appdir", httpsUrl), { caPath });
              expect(appDir.status, `${serviceName} appdir`).toBe(200);
              expect(appDir.body).toBe("app-dir-index");
            }
          }
          console.log(
            "PHP_ROUTE_CLI_EVIDENCE",
            JSON.stringify({ name, root, binary, privateFiles, startMs, routes: evidence }),
          );
        } finally {
          await cli(root, ["destroy", "--volumes", "--yes"], 90_000);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    900_000,
  );
});
