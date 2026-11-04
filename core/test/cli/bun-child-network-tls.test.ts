import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { Effect } from "effect";

import {
  BUN_CAFILE_FLAG,
  BUN_NO_INSTALL_FLAG,
  NODE_EXTRA_CA_CERTS_ENV,
} from "../../src/cli/commands/bun-child-network-policy.ts";
import { projectBunChildNetwork } from "../../src/cli/commands/bun-child-network.ts";

const bunVersion = Bun.version;

test.skipIf(process.platform === "win32").each(["bearer", "basic"] as const)(
  `real Bun ${bunVersion} %s install honors projected NODE_EXTRA_CA_CERTS and strict --cafile`,
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-bun-tls-"));
    const requests: { path: string; ok: boolean }[] = [];
    const token = "bun-install-auth-canary";
    const basic = Buffer.from('alice:punctuation:@\\$"canary${literal}').toString("base64");
    const authorization = kind === "bearer" ? `Bearer ${token}` : `Basic ${basic}`;
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
    const [tlsCode, pem, tlsError] = await Promise.all([
      openssl.exited,
      new Response(openssl.stdout).text(),
      new Response(openssl.stderr).text(),
    ]);
    if (tlsCode !== 0) throw new Error(`TLS fixture failed: ${tlsError}`);
    const cert = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/u)?.[0];
    const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/u)?.[0];
    if (cert === undefined || key === undefined) throw new Error("Missing TLS material");
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const caPath = join(root, "ca.pem");
      const unrelatedRoot = rootCertificates[0];
      if (unrelatedRoot === undefined) throw new Error("Missing runtime CA roots");
      await writeFile(caPath, `${cert}\n${unrelatedRoot}\n`);
      const pkgDir = join(root, "pkg");
      await mkdir(pkgDir);
      await writeFile(
        join(pkgDir, "package.json"),
        JSON.stringify({ name: "@hti/tls-dep", version: "1.0.0" }),
      );
      const tarPath = join(root, "pkg.tgz");
      const tar = Bun.spawn(["tar", "-czf", tarPath, "-C", root, "pkg"], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [tarCode, tarErr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
      if (tarCode !== 0) throw new Error(tarErr);
      const archive = await readFile(tarPath);
      const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(archive).digest("base64")}`;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert, key },
        fetch: (request) => {
          const url = new URL(request.url);
          const ok = request.headers.get("authorization") === authorization;
          requests.push({ path: url.pathname, ok });
          if (!ok) return new Response("registry authentication required", { status: 401 });
          if (url.pathname.endsWith(".tgz")) return new Response(archive);
          return Response.json({
            "dist-tags": { latest: "1.0.0" },
            versions: {
              "1.0.0": { dist: { tarball: `${url.origin}/pkg.tgz`, integrity } },
            },
          });
        },
      });
      const registry = server.url.href;
      const npmrc = `@hti:registry=${registry}\n//127.0.0.1:${server.port}/:${kind === "bearer" ? "_authToken=${HTI_NPM_TOKEN}" : "_auth=${HTI_NPM_AUTH}"}\n`;
      const cache = join(root, "cache");
      const work = join(root, "work");
      await mkdir(work);
      await writeFile(
        join(work, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { "@hti/tls-dep": "1.0.0" } }),
      );
      await writeFile(join(work, ".npmrc"), npmrc);

      const hostEnv: Record<string, string> = {
        LANDO_USER_CACHE_ROOT: cache,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CONF_ROOT: join(root, "conf"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(root, "system"),
        PATH: process.env.PATH ?? "",
        HTI_NPM_TOKEN: token,
        HTI_NPM_AUTH: basic,
        ...(kind === "bearer" ? { BUN_CONFIG_TOKEN: token } : {}),
      };
      const envFor = (workdir: string, base: Record<string, string> = hostEnv): Record<string, string> => ({
        ...base,
        // Isolate Bun's install cache so a prior good CA install cannot mask a bad-CA failure.
        BUN_INSTALL_CACHE_DIR: join(workdir, ".bun-cache"),
        npm_config_cache: join(workdir, ".npm-cache"),
      });
      const hostProjected = await Effect.runPromise(
        projectBunChildNetwork({
          env: { ...hostEnv },
          argv: ["install", `--registry=${registry}`],
          verb: "install",
          plan: {
            proxy: { noProxy: [] },
            caCertPaths: [caPath],
            trustHost: true,
          },
        }),
      );
      expect(hostProjected.env[NODE_EXTRA_CA_CERTS_ENV]).toBeDefined();
      const hostInstall = Bun.spawn([process.execPath, ...hostProjected.argv], {
        cwd: work,
        env: envFor(work, hostProjected.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [hostCode, hostOut, hostErr] = await Promise.all([
        hostInstall.exited,
        new Response(hostInstall.stdout).text(),
        new Response(hostInstall.stderr).text(),
      ]);
      expect(hostCode, `host install failed: ${hostOut}\n${hostErr}`).toBe(0);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.ok)).toBe(true);

      // Wrong CA under host extra must fail closed.
      const badCa = join(root, "bad.pem");
      await writeFile(badCa, unrelatedRoot);
      // Use a second workdir so lockfile state is clean
      const work2 = join(root, "work2");
      await mkdir(work2);
      await writeFile(
        join(work2, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { "@hti/tls-dep": "1.0.0" } }),
      );
      const beforeWrong = requests.length;
      await writeFile(join(work2, ".npmrc"), npmrc);
      const wrongProjected = await Effect.runPromise(
        projectBunChildNetwork({
          env: { ...hostEnv },
          argv: ["install", `--registry=${registry}`],
          verb: "install",
          plan: {
            proxy: { noProxy: [] },
            caCertPaths: [badCa],
            trustHost: true,
          },
        }),
      );
      const wrongInstall = Bun.spawn([process.execPath, ...wrongProjected.argv], {
        cwd: work2,
        env: envFor(work2, wrongProjected.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [wrongCode] = await Promise.all([
        wrongInstall.exited,
        new Response(wrongInstall.stdout).text(),
        new Response(wrongInstall.stderr).text(),
      ]);
      expect(wrongCode).not.toBe(0);
      expect(requests.length).toBe(beforeWrong);

      // Strict --cafile with correct CA succeeds.
      const work3 = join(root, "work3");
      await mkdir(work3);
      await writeFile(
        join(work3, "package.json"),
        JSON.stringify({ name: "consumer", version: "1.0.0", dependencies: { "@hti/tls-dep": "1.0.0" } }),
      );
      const strictProjected = await Effect.runPromise(
        projectBunChildNetwork({
          env: { ...hostEnv },
          argv: ["install", `--registry=${registry}`],
          verb: "install",
          plan: {
            proxy: { noProxy: [] },
            caCertPaths: [caPath],
            trustHost: false,
          },
        }),
      );
      await writeFile(join(work3, ".npmrc"), npmrc);
      expect(strictProjected.argv[0]).toBe("install");
      expect(strictProjected.argv[1]).toBe(BUN_CAFILE_FLAG);
      expect(strictProjected.env[NODE_EXTRA_CA_CERTS_ENV]).toBeUndefined();
      const strictInstall = Bun.spawn([process.execPath, ...strictProjected.argv], {
        cwd: work3,
        env: envFor(work3, strictProjected.env),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [strictCode, strictOut, strictErr] = await Promise.all([
        strictInstall.exited,
        new Response(strictInstall.stdout).text(),
        new Response(strictInstall.stderr).text(),
      ]);
      expect(strictCode, `strict install failed: ${strictOut}\n${strictErr}`).toBe(0);

      // bunx --no-install confinement: missing local binary fails without registry hit
      await mkdir(join(work3, "node_modules/.bin"), { recursive: true });
      const localBin = join(work3, "node_modules/.bin/hti-local-bin");
      await writeFile(localBin, "#!/usr/bin/env bun\nprocess.stdout.write('local-binary-ran');\n");
      await chmod(localBin, 0o755);
      const localProjected = await Effect.runPromise(
        projectBunChildNetwork({
          env: { ...hostEnv },
          argv: ["x", "hti-local-bin"],
          verb: "x",
          plan: { proxy: { noProxy: [] }, caCertPaths: [caPath], trustHost: false },
        }),
      );
      const beforeLocal = requests.length;
      const local = Bun.spawn([process.execPath, ...localProjected.argv], {
        cwd: work3,
        env: { ...envFor(work3, localProjected.env), BUN_CONFIG_REGISTRY: registry },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [localCode, localOut, localErr] = await Promise.all([
        local.exited,
        new Response(local.stdout).text(),
        new Response(local.stderr).text(),
      ]);
      expect(localCode, localErr).toBe(0);
      expect(localOut).toBe("local-binary-ran");
      expect(requests.length).toBe(beforeLocal);
      const beforeBunx = requests.length;
      const bunxProjected = await Effect.runPromise(
        projectBunChildNetwork({
          env: { ...hostEnv },
          argv: ["x", "hti-missing-bin-zzzz"],
          verb: "x",
          plan: {
            proxy: { noProxy: [] },
            caCertPaths: [caPath],
            trustHost: false,
          },
        }),
      );
      expect(bunxProjected.argv).toEqual(["x", BUN_NO_INSTALL_FLAG, "hti-missing-bin-zzzz"]);
      const bunx = Bun.spawn([process.execPath, ...bunxProjected.argv], {
        cwd: work3,
        env: { ...envFor(work3, bunxProjected.env), BUN_CONFIG_REGISTRY: registry },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [bunxCode, , bunxErr] = await Promise.all([
        bunx.exited,
        new Response(bunx.stdout).text(),
        new Response(bunx.stderr).text(),
      ]);
      expect(bunxCode).not.toBe(0);
      expect(bunxErr).toMatch(/no-install|Could not find/i);
      expect(requests.length).toBe(beforeBunx);
    } finally {
      server?.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
