import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import { binary, cli, decodeStart, infoEnvelope, prerequisite, run } from "./route-cli-live-support.ts";

const request = async (root: string, url: URL, headers: readonly string[] = []) => {
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
      `Host: ${url.host}`,
      ...headers.flatMap((header) => ["--header", header]),
      ...(url.protocol === "https:" ? ["--insecure"] : []),
      // Raw Location preserves nginx's relative redirect; redirect_url would expand it.
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
    "honors router HTTPS, preserves directory redirects, and denies hidden paths and PHP case variants",
    async () => {
      if (prerequisite !== undefined) throw new Error(prerequisite);
      // Given: an installed managed router and Apache plus nginx/FPM in one isolated app.
      const root = await mkdtemp(join(tmpdir(), "lando-php-route-cli-"));
      const name = `php-route-cli-${crypto.randomUUID()}`;
      const secret = `env-secret-${crypto.randomUUID()}`;
      const source = `php-source-${crypto.randomUUID()}`;
      try {
        const global = Schema.decodeUnknownSync(infoEnvelope)(await cli(root, ["global:info"])).result;
        expect(
          global.services.find((service) => service.service === "traefik"),
          "The inherited roots must contain the installed managed global Traefik app; this test never runs setup.",
        ).toMatchObject({ provider: "lando" });
        await chmod(root, 0o755);
        await mkdir(join(root, "sub"), { mode: 0o755 });
        const files = {
          "scheme.php": "<?php echo 'HTTPS=' . ($_SERVER['HTTPS'] ?? '');\n",
          "sub/index.php": "<?php echo 'sub-index';\n",
          ".env": secret,
          "secret.PHP": `<?php echo strrev('${source}');\n`,
          ".lando.yml": [
            `name: ${name}`,
            "runtime: 4",
            "provider: lando",
            "services:",
            "  appserver:",
            '    type: "php:8.3"',
            "    primary: true",
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
          await chmod(join(root, path), 0o644);
        }
        try {
          // When: the real compiled CLI plans and starts both generated server configurations.
          await cli(root, ["app:cache:refresh"]);
          const startAt = performance.now();
          const started = decodeStart(await cli(root, ["start"], 720_000));
          const startMs = performance.now() - startAt;
          const evidence = [];
          for (const [serviceName, hostname] of [
            ["appserver", `${name}.lndo.site`],
            ["edge", `edge-${name}.lndo.site`],
          ] as const) {
            const service = started.servicesStarted.find((item) => item.name === serviceName);
            for (const scheme of ["https", "http"] as const) {
              const route = service?.connections.find(
                (connection) =>
                  connection.source === "route" &&
                  connection.binding === "assigned" &&
                  connection.host === hostname &&
                  connection.url?.startsWith(`${scheme}://`),
              );
              if (route?.url === undefined)
                throw new Error(`start published no ${scheme} route for ${hostname}`);
              const url = new URL(route.url);
              expect(url.hostname).toBe(hostname);
              // Then: router TLS controls PHP's HTTPS value, even against a spoofed client header.
              const php = await request(
                root,
                new URL("/scheme.php", url),
                scheme === "http" ? ["X-Forwarded-Proto: https"] : [],
              );
              expect(php.status, `${serviceName} ${scheme} scheme.php`).toBe(200);
              expect(php.body).toBe(scheme === "https" ? "HTTPS=on" : "HTTPS=");
              const redirect = await request(root, new URL("/sub", url));
              expect(redirect.status, `${serviceName} ${scheme} /sub`).toBe(301);
              expect(redirect.location).toBe(
                serviceName === "appserver" ? `${scheme}://${url.host}/sub/` : "/sub/",
              );
              if (scheme === "https") {
                for (const [path, marker] of [
                  ["/.env", secret],
                  ["/secret.PHP", source],
                ] as const) {
                  const denied = await request(root, new URL(path, url));
                  expect(denied.status, `${serviceName} ${path}`).toBe(403);
                  expect(denied.body).not.toContain(marker);
                }
              }
              evidence.push({ service: serviceName, url: url.href, https: php.body, redirect });
            }
          }
          console.log(
            "PHP_ROUTE_CLI_EVIDENCE",
            JSON.stringify({ name, root, binary, startMs, routes: evidence }),
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
