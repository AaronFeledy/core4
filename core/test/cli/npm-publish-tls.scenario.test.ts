import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

test.skipIf(process.platform === "win32")(
  "real Bun publishes exact Bearer and punctuation Basic credentials over verified HTTPS",
  async () => {
    const cli = new URL("../../bin/lando.ts", import.meta.url).pathname;
    const openssl = Bun.spawn(
      [
        "bash",
        "-o",
        "pipefail",
        "-c",
        "openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout /dev/stdout -out /dev/stdout | cat",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, pem, tlsError] = await Promise.all([
      openssl.exited,
      new Response(openssl.stdout).text(),
      new Response(openssl.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`TLS fixture failed: ${tlsError}`);
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/u)?.[0];
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/u)?.[0];
    if (cert === undefined || key === undefined) throw new Error("Missing TLS fixture");
    const root = await mkdtemp(join(tmpdir(), "lando-publish-tls-"));
    const token = "bearer-publish-canary-hti";
    const password = 'punctuation:@\\$"canary${literal}';
    const basic = Buffer.from(`alice:${password}`).toString("base64");
    const requests: { method: string; path: string; authorization: string | null; name: unknown }[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert, key },
      fetch: async (request) => {
        const body = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(await request.json());
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          name: body.name,
        });
        return Response.json({ ok: true });
      },
    });
    try {
      const registry = server.url.href;
      await writeFile(join(root, "ca.pem"), cert);
      await mkdir(join(root, "src"));
      await mkdir(join(root, "dist"));
      const name = "@acme/lando-plugin-publish-tls";
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          type: "module",
          exports: { ".": "./src/index.ts" },
          publishConfig: { registry: "https://wrong.invalid/" },
          landoPlugin: { name, version: "1.0.0", api: 4, entry: "src/index.ts" },
        }),
      );
      await writeFile(join(root, "src/index.ts"), "export {};\n");
      for (const file of ["index.js", "index.d.ts"])
        await writeFile(join(root, "dist", file), "export {};\n");
      await writeFile(
        join(root, "dist/package.json"),
        JSON.stringify({ name, version: "1.0.0", publishConfig: { registry: "https://wrong.invalid/" } }),
      );
      await writeFile(
        join(root, "dist/bunfig.toml"),
        '[install.scopes]\n"@acme" = "https://wrong.invalid/"\n',
      );
      const future = new Date(Date.now() + 60_000);
      for (const file of ["index.js", "index.d.ts", "package.json"])
        await utimes(join(root, "dist", file), future, future);
      const run = async (auth: string, trust = true) => {
        await writeFile(join(root, "npmrc"), `//127.0.0.1:${server.port}/:${auth}\n`);
        const child = Bun.spawn(
          [
            process.execPath,
            cli,
            "meta:plugin:publish",
            "--no-test",
            `--registry=${registry}`,
            "--format=json",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              NPM_CONFIG_USERCONFIG: join(root, "npmrc"),
              BUN_CONFIG_TOKEN: "wrong-inherited-token",
              NPM_CONFIG_TOKEN: "other-wrong-token",
              npm_config_token: "lower-wrong-token",
              BUN_AUTH_TOKEN: "ignored-wrong-token",
              BUN_CONFIG_REGISTRY: "https://wrong.invalid/",
              NPM_CONFIG_REGISTRY: "https://upper-wrong.invalid/",
              npm_config_registry: "https://lower-wrong.invalid/",
              LANDO_NETWORK_CA_CERTS: JSON.stringify(trust ? [join(root, "ca.pem")] : []),
              LANDO_USER_CONF_ROOT: join(root, "conf"),
              LANDO_USER_CACHE_ROOT: join(root, "cache"),
              LANDO_USER_DATA_ROOT: join(root, "data"),
              LANDO_TELEMETRY: "off",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        for (const secret of [
          token,
          password,
          basic,
          "wrong-inherited-token",
          "other-wrong-token",
          "lower-wrong-token",
          "ignored-wrong-token",
        ])
          expect(stdout + stderr).not.toContain(secret);
        return { exitCode, stdout, stderr };
      };

      const bearer = await run(`_authToken=${token}`);
      expect(bearer.exitCode, bearer.stdout + bearer.stderr).toBe(0);
      expect(JSON.parse(bearer.stdout)).toMatchObject({ ok: true, result: { published: true } });
      expect(requests.at(-1)).toEqual({
        method: "PUT",
        path: "/@acme%2flando-plugin-publish-tls",
        authorization: `Bearer ${token}`,
        name,
      });
      const basicResult = await run(`_auth=${basic}`);
      expect(basicResult.exitCode, basicResult.stdout + basicResult.stderr).toBe(0);
      expect(JSON.parse(basicResult.stdout)).toMatchObject({ ok: true, result: { published: true } });
      expect(requests.at(-1)).toEqual({
        method: "PUT",
        path: "/@acme%2flando-plugin-publish-tls",
        authorization: `Basic ${basic}`,
        name,
      });
      const before = requests.length;
      const untrusted = await run(`_auth=${basic}`, false);
      expect(untrusted.exitCode).toBe(1);
      expect(requests.length).toBe(before);
      expect(untrusted.stdout + untrusted.stderr).toMatch(/certificate|issuer|TLS/iu);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
