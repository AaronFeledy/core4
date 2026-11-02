import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform === "win32").each(["bearer", "basic", "password"] as const)(
  "source CLI installs with %s from a private HTTPS npm registry and safely reports rejected auth",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-private-npm-"));
    const cli = new URL("../../bin/lando.ts", import.meta.url).pathname;
    const token = "local-private-registry-canary-1489";
    const basic = Buffer.from(`alice:${token}`).toString("base64");
    const expectedAuth = kind === "bearer" ? `Bearer ${token}` : `Basic ${basic}`;
    const packageName = "@acme/lando-plugin-private";
    const requests: { path: string; authenticated: boolean }[] = [];
    const inMemoryPemCommand =
      "openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 -keyout /dev/stdout -out /dev/stdout | cat";
    const openssl = Bun.spawn(["bash", "-o", "pipefail", "-c", inMemoryPemCommand], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [tlsCode, pem, tlsError] = await Promise.all([
      openssl.exited,
      new Response(openssl.stdout).text(),
      new Response(openssl.stderr).text(),
    ]);
    if (tlsCode !== 0) throw new Error(`TLS fixture failed: ${tlsError}`);
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/u)?.[0];
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/u)?.[0];
    if (cert === undefined || key === undefined) throw new Error("Missing in-memory TLS fixture material");
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      await writeFile(join(root, "ca.pem"), cert);
      await mkdir(join(root, "package"));
      await writeFile(
        join(root, "package", "package.json"),
        JSON.stringify({
          name: packageName,
          version: "1.0.0",
          scripts: { postinstall: "bun postinstall.mjs" },
          landoPlugin: { name: packageName, version: "1.0.0", api: 4, entry: "index.js" },
        }),
      );
      await writeFile(join(root, "package", "index.js"), "export {};\n");
      await writeFile(
        join(root, "package", "postinstall.mjs"),
        'const response = await fetch(`${process.env.LANDO_TEST_REGISTRY}postinstall`, {headers: {authorization: process.env.LANDO_TEST_REGISTRY_AUTH}}); if (!response.ok) throw new Error("postinstall registry request failed"); await Bun.write("postinstall-ok", "ok");\n',
      );
      await mkdir(join(root, "package", "fragments"));
      await writeFile(
        join(root, "package", "fragments", "shared.yml"),
        "services:\n  web:\n    type: node:22\n",
      );
      const tar = Bun.spawn(["tar", "-czf", join(root, "package.tgz"), "-C", root, "package"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [tarCode, tarError] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
      if (tarCode !== 0) throw new Error(`Tar fixture failed: ${tarError}`);
      const archive = await readFile(join(root, "package.tgz"));
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert, key },
        fetch: (request) => {
          const url = new URL(request.url);
          const authenticated = request.headers.get("authorization") === expectedAuth;
          requests.push({ path: url.pathname, authenticated });
          if (!authenticated) return new Response(`rejected ${token}`, { status: 401 });
          if (url.pathname === "/archive.tgz") return new Response(archive);
          return Response.json({
            "dist-tags": { latest: "1.0.0" },
            versions: { "1.0.0": { dist: { tarball: `${url.origin}/archive.tgz`, integrity } } },
          });
        },
      });
      const registry = server.url.href;
      const env = {
        ...process.env,
        LANDO_TEST_REGISTRY: registry,
        LANDO_TEST_REGISTRY_AUTH: expectedAuth,
        NPM_CONFIG_USERCONFIG: join(root, "absent-user-config"),
        "npm_config_@acme:registry": registry,
        ...(kind === "bearer"
          ? { [`npm_config_//127.0.0.1:${server.port}/:_authToken`]: token }
          : kind === "basic"
            ? { [`npm_config_//127.0.0.1:${server.port}/:_auth`]: basic }
            : {
                [`npm_config_//127.0.0.1:${server.port}/:username`]: "alice",
                [`npm_config_//127.0.0.1:${server.port}/:_password`]: Buffer.from(token).toString("base64"),
              }),
        LANDO_NETWORK_CA_CERTS: JSON.stringify([join(root, "ca.pem")]),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        LANDO_TELEMETRY: "off",
      };
      const run = async (argv: readonly string[], overrides: Record<string, string> = {}, cwd = root) => {
        const child = Bun.spawn([process.execPath, cli, ...argv, "--format=json"], {
          cwd,
          env: { ...env, ...overrides },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      };
      const installed = await run(["plugin:add", packageName, "--trust"]);
      expect(installed.exitCode).toBe(0);
      expect(JSON.parse(installed.stdout)).toMatchObject({ ok: true });
      expect(
        await Bun.file(join(root, "data", "plugins", packageName, "1.0.0", "package.json")).exists(),
      ).toBe(true);
      expect(requests).toEqual([
        { path: "/@acme%2flando-plugin-private", authenticated: true },
        { path: "/archive.tgz", authenticated: true },
        { path: "/postinstall", authenticated: true },
      ]);
      expect(
        await Bun.file(join(root, "data", "plugins", packageName, "1.0.0", "postinstall-ok")).text(),
      ).toBe("ok");
      const rejected = await run(["plugin:add", "@acme/denied", "--trust"], {
        [`npm_config_//127.0.0.1:${server.port}/:_authToken`]: "wrong-local-token",
      });
      expect(rejected.exitCode).toBe(1);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        ok: false,
        error: { _tag: "PluginPackageOperationError" },
      });
      expect(rejected.stdout).toContain("401");
      expect(rejected.stdout).toContain(":_authToken token from your npm configuration");
      expect(installed.stdout + installed.stderr + rejected.stdout + rejected.stderr).not.toContain(token);
      expect(rejected.stdout + rejected.stderr).not.toContain("wrong-local-token");
      expect(installed.stdout + installed.stderr + rejected.stdout + rejected.stderr).not.toContain(basic);
      const app = join(root, "include-app");
      await mkdir(app);
      await writeFile(
        join(app, ".lando.yml"),
        `name: private-includes\nincludes:\n  - npm:${packageName}/fragments/shared.yml@1.0.0\n`,
      );
      const includeEnv = { LANDO_USER_DATA_ROOT: join(root, "include-data") };
      const included = await run(["app:config"], includeEnv, app);
      expect(included.exitCode).toBe(0);
      expect(included.stdout).toContain("node:22");
      expect(included.stdout + included.stderr).not.toContain(token);
      const requestCount = requests.length;
      const cached = await run(["app:config"], { ...includeEnv, NPM_CONFIG_USERCONFIG: root }, app);
      expect(cached.exitCode).toBe(0);
      expect(requests.length).toBe(requestCount);
      expect(cached.stdout + cached.stderr).not.toContain(token);
      await writeFile(
        join(app, ".lando.yml"),
        "name: denied-includes\nincludes:\n  - npm:@acme/denied/fragments/shared.yml@1.0.0\n",
      );
      const deniedInclude = await run(
        ["app:config"],
        { ...includeEnv, [`npm_config_//127.0.0.1:${server.port}/:_authToken`]: "wrong-local-token" },
        app,
      );
      expect(deniedInclude.exitCode).toBe(1);
      expect(deniedInclude.stdout).toContain("LandofileIncludeError");
      expect(deniedInclude.stdout).toContain(":_authToken token from your npm configuration");
      expect(deniedInclude.stdout + deniedInclude.stderr).not.toContain(token);
      expect(deniedInclude.stdout + deniedInclude.stderr).not.toContain("wrong-local-token");
    } finally {
      server?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
