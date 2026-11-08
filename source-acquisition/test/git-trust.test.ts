import { expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedNetworkTrust } from "@lando/sdk/network-trust";
import type { ProcessSpawnOptions } from "@lando/sdk/services";
import { Effect } from "effect";
import { makeGitTransport } from "../src/git.ts";
import { makeTestProcessRunner } from "../src/testing.ts";

const commit = "a".repeat(40);
const trust: ResolvedNetworkTrust = {
  proxy: {
    http: "http://user:secret@http-proxy.test:8080",
    https: "http://https-proxy.test:8081",
    noProxy: ["bypass.test"],
  },
  caPems: [],
  trustHost: true,
};

test.each([
  ["http://remote.test/r.git", trust.proxy.http],
  ["https://remote.test/r.git", trust.proxy.https],
  ["https://bypass.test/r.git", ""],
  ["https://127.0.0.1/r.git", ""],
  ["https://remote.test/r.git", ""],
])("git HTTP trust selects authoritative proxy for %s (%s)", async (url, proxy) => {
  const observed: ProcessSpawnOptions[] = [];
  const runner = {
    ...makeTestProcessRunner(),
    run: (input: ProcessSpawnOptions) => {
      observed.push(input);
      return Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD\n`, stderr: "" });
    },
  };
  const selected = proxy === "" && url.includes("remote.test") ? { ...trust, proxy: { noProxy: [] } } : trust;
  const transport = makeGitTransport(runner, { trust: selected, systemCaPems: () => [] });
  await transport.resolve?.({ url });
  expect(observed).toHaveLength(1);
  expect(observed[0]?.args).toContain(`http.proxy=${proxy}`);
  expect(observed[0]?.env).toMatchObject({ NO_PROXY: "", no_proxy: "", GIT_TERMINAL_PROMPT: "0" });
});

test.each(["ssh://git@remote.test/r.git", "git@remote.test:r.git"])(
  "SSH trust is untouched for %s",
  async (url) => {
    const observed: ProcessSpawnOptions[] = [];
    const transport = makeGitTransport(
      {
        ...makeTestProcessRunner(),
        run: (input) => {
          observed.push(input);
          return Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD`, stderr: "" });
        },
      },
      {
        trust: async () => {
          throw new Error("SSH must not resolve HTTP trust");
        },
        systemCaPems: () => [],
      },
    );
    expect(await transport.resolve?.({ url })).toBe(commit);
    expect(observed[0]?.args).toEqual(["ls-remote", "--", url, "HEAD", "HEAD^{}"]);
    expect(observed[0]?.env).not.toHaveProperty("NO_PROXY");
  },
);

test("undefined trust leaves inherited proxy and CA behavior unchanged", async () => {
  const observed: ProcessSpawnOptions[] = [];
  const transport = makeGitTransport({
    ...makeTestProcessRunner(),
    run: (input) => {
      observed.push(input);
      return Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD`, stderr: "" });
    },
  });
  await transport.resolve?.({ url: "https://remote.test/r.git" });
  expect(observed[0]?.args).toEqual(["ls-remote", "--", "https://remote.test/r.git", "HEAD", "HEAD^{}"]);
  expect(observed[0]?.env).not.toHaveProperty("NO_PROXY");
});

test.each([true, false])(
  "git CA bundle honors host trust (%s), is private, and is removed after both network operations",
  async (trustHost) => {
    const root = await mkdtemp(join(tmpdir(), "lando-git-ca-test-"));
    const bundles: string[] = [];
    const runner = {
      ...makeTestProcessRunner(),
      run: (input: ProcessSpawnOptions) =>
        Effect.promise(async () => {
          if (input.args.includes("ls-remote") || input.args.includes("fetch")) {
            const ca = input.args
              .find((arg) => arg.startsWith("http.sslCAInfo="))
              ?.slice("http.sslCAInfo=".length);
            if (ca === undefined) throw new Error("missing CA bundle");
            bundles.push(ca);
            expect((await stat(ca)).mode & 0o777).toBe(0o600);
            expect(await readFile(ca, "utf8")).toBe(trustHost ? "system-pem\ncustom-pem" : "custom-pem");
            expect(input.args).toContain(`http.proxy=${trust.proxy.https}`);
          }
          return {
            exitCode: 0,
            stdout: input.args.includes("ls-remote") ? `${commit}\tHEAD` : commit,
            stderr: "",
          };
        }),
    };
    const transport = makeGitTransport(runner, {
      trust: { ...trust, caPems: ["custom-pem"], trustHost },
      systemCaPems: () => ["system-pem"],
    });
    try {
      await transport.resolve?.({ url: "https://remote.test/r.git" });
      await transport.fetch({ url: "https://remote.test/r.git", dest: join(root, "tree") });
      expect(bundles).toHaveLength(2);
      for (const bundle of bundles) await expect(access(bundle)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("git failure redacts proxy credentials and still cleans up its CA bundle", async () => {
  let bundle: string | undefined;
  const transport = makeGitTransport(
    {
      ...makeTestProcessRunner(),
      run: (input) => {
        bundle = input.args.find((arg) => arg.startsWith("http.sslCAInfo="))?.slice("http.sslCAInfo=".length);
        return Effect.succeed({
          exitCode: 1,
          stdout: "",
          stderr: `Could not connect to ${trust.proxy.http}; credentials user:secret rejected`,
        });
      },
    },
    { trust: { ...trust, caPems: ["custom-pem"] }, systemCaPems: () => [] },
  );
  await expect(transport.resolve?.({ url: "http://remote.test/r.git" })).rejects.toMatchObject({
    kind: "fetch-failed",
    message: "Could not connect to http://http-proxy.test:8080; credentials [redacted]:[redacted] rejected",
  });
  expect(bundle).toBeDefined();
  if (bundle !== undefined) await expect(access(bundle)).rejects.toThrow();
});

test("one transport resolves network trust once for ls-remote and fetch", async () => {
  let resolutions = 0;
  const runner = {
    ...makeTestProcessRunner(),
    run: (input: ProcessSpawnOptions) =>
      Effect.succeed({
        exitCode: 0,
        stdout: input.args.includes("rev-parse") ? commit : `${commit}\tHEAD\n`,
        stderr: "",
      }),
  };
  const transport = makeGitTransport(runner, {
    trust: async () => {
      resolutions += 1;
      return trust;
    },
    systemCaPems: () => [],
  });
  const dest = await mkdtemp(join(tmpdir(), "lando-git-trust-once-"));
  try {
    await transport.resolve?.({ url: "https://remote.test/r.git" });
    await transport.fetch({ url: "https://remote.test/r.git", dest });
    expect(resolutions).toBe(1);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
});

test("a failed trust resolution is retried by the next git command", async () => {
  let resolutions = 0;
  const runner = {
    ...makeTestProcessRunner(),
    run: () => Effect.succeed({ exitCode: 0, stdout: `${commit}\tHEAD\n`, stderr: "" }),
  };
  const transport = makeGitTransport(runner, {
    trust: async () => {
      resolutions += 1;
      if (resolutions === 1) throw new Error("config unreadable");
      return trust;
    },
    systemCaPems: () => [],
  });
  await expect(transport.resolve?.({ url: "https://remote.test/r.git" })).rejects.toThrow(
    "config unreadable",
  );
  expect(await transport.resolve?.({ url: "https://remote.test/r.git" })).toBe(commit);
  expect(resolutions).toBe(2);
});
