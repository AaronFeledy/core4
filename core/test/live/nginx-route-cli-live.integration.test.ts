import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigLintResult } from "@lando/sdk/schema";
import { Schema } from "effect";

import { binary, cli, decodeStart, infoEnvelope, prerequisite, run } from "./route-cli-live-support.ts";
const lintEnvelope = Schema.fromJsonString(
  Schema.Struct({ ok: Schema.Literal(true), result: ConfigLintResult }),
);

describe.serial("compiled CLI managed nginx routing", () => {
  test.skipIf(prerequisite !== undefined && process.env.LANDO_GUIDE_E2E !== "1")(
    "serves the app body through global Traefik when nginx uses a nondefault listener",
    async () => {
      if (prerequisite !== undefined) throw new Error(prerequisite);
      // Given: an installed managed router and a uniquely named app outside the checkout.
      const root = await mkdtemp(join(tmpdir(), "lando-nginx-route-cli-"));
      const name = `route-cli-${crypto.randomUUID()}`;
      const hostname = `${name}.lndo.site`;
      const body = `nginx-route-proof-${crypto.randomUUID()}`;
      try {
        const global = Schema.decodeUnknownSync(infoEnvelope)(await cli(root, ["global:info"])).result;
        expect(
          global.services.find((service) => service.service === "traefik"),
          "The inherited roots must contain the installed managed global Traefik app; this test never runs setup.",
        ).toMatchObject({ provider: "lando" });
        const publicRoot = join(root, "public");
        await mkdir(publicRoot);
        await chmod(root, 0o755);
        await chmod(publicRoot, 0o755);
        await Bun.write(join(publicRoot, "index.html"), body);
        await chmod(join(publicRoot, "index.html"), 0o644);
        await Bun.write(
          join(root, ".lando.yml"),
          [
            `name: ${name}`,
            "runtime: 4",
            "provider: lando",
            "services:",
            "  web:",
            "    type: nginx",
            "    primary: true",
            "    port: 8123",
            "    webroot: public",
            "    routes:",
            `      - hostname: ${hostname}`,
            "        scheme: http",
            "",
          ].join("\n"),
        );
        try {
          // When: the real binary validates, plans, starts, and observes the unmodified bundled launcher.
          const lint = Schema.decodeUnknownSync(lintEnvelope)(await cli(root, ["app:config:lint"]));
          expect(lint.result.valid).toBe(true);
          await cli(root, ["app:cache:refresh"]);
          const startAt = performance.now();
          const output = await cli(root, ["start"], 300_000);
          const readyAt = performance.now();
          const started = decodeStart(output);
          const initialRoute = started.servicesStarted
            .find((service) => service.name === "web")
            ?.connections.find(
              (connection) =>
                connection.source === "route" &&
                connection.host === hostname &&
                connection.binding === "assigned",
            );
          if (initialRoute?.url === undefined) throw new Error(`start published no route URL for ${name}`);
          const url = new URL(initialRoute.url);
          expect(url.hostname).toBe(hostname);
          const port = url.port || (url.protocol === "https:" ? "443" : "80");
          // Then: only the discovered ingress URL, resolved to loopback with its Host header, serves this body.
          const response = await run(
            root,
            [
              "curl",
              "--silent",
              "--show-error",
              "--fail",
              "--noproxy",
              "*",
              "--connect-timeout",
              "3",
              "--max-time",
              "5",
              "--resolve",
              `${hostname}:${port}:127.0.0.1`,
              "--header",
              `Host: ${url.host}`,
              // Trust relaxation is confined to this unique fixture host, with no redirects followed.
              ...(url.protocol === "https:" ? ["--insecure"] : []),
              "--write-out",
              "\n%{http_code}",
              url.href,
            ],
            30_000,
          );
          const firstHttpMs = performance.now() - readyAt;
          expect(response).toBe(`${body}\n200`);
          const info = Schema.decodeUnknownSync(infoEnvelope)(await cli(root, ["info"])).result;
          const web = info.services.find((service) => service.service === "web");
          if (web === undefined) throw new Error(`info omitted web for ${name}`);
          expect(web.provider).toBe("lando");
          const listener = web.connections.find((connection) => connection.scope === "app");
          expect(listener).toMatchObject({
            source: "listener",
            binding: "assigned",
            port: 8123,
            protocol: "http",
            state: "active",
          });
          expect(web.connections.filter((connection) => connection.source === "publication")).toEqual([]);
          const route = web.connections.find(
            (connection) => connection.source === "route" && connection.host === hostname,
          );
          expect(route).toMatchObject({
            scope: "host",
            source: "route",
            state: "active",
            endpoint: listener?.endpoint,
          });
          console.log(
            "NGINX_ROUTE_CLI_EVIDENCE",
            JSON.stringify({
              name,
              root,
              binary,
              listener,
              route,
              status: 200,
              body,
              startMs: readyAt - startAt,
              firstHttpMs,
            }),
          );
        } finally {
          await cli(root, ["destroy", "--volumes", "--yes"], 90_000);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    720_000,
  );
});
