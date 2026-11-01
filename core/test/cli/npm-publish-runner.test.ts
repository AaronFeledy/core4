import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { Effect } from "effect";
import { publishWithCredential } from "../../src/cli/commands/npm-publish-runner";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";
import { withProcess } from "../_support/process-runner";
import { withEnvVar } from "../_support/temp-cwd";

test.each([0, 1])(
  "Basic config is private, secret-free and finalized after child exit %i",
  async (exitCode) => {
    const password = 'literal:@\\$"canary';
    const config = parseNpmRegistryConfig(
      `//registry.test/:_auth=${Buffer.from(`alice:${password}`).toString("base64")}`,
    );
    const credential = config.credentialFor("https://registry.test/", "https://registry.test/");
    if (credential === undefined) throw new Error("Missing test credential");
    let path = "";

    const result = await withEnvVar("BUN_CONFIG_TOKEN", "wrong-ambient-token", () =>
      Effect.runPromise(
        publishWithCredential(
          credential,
          { registry: "https://registry.test/", packageName: "@acme/plugin", tag: "next" },
          { cwd: process.cwd(), output: "quiet" },
        ).pipe(
          withProcess(async ({ cmd, env }) => {
            const arg = cmd.find((value) => value.startsWith("--config="));
            if (arg === undefined) throw new Error("Missing equals-form config argument");
            path = arg.slice("--config=".length);
            const text = await readFile(path, "utf8");
            const parsed = Bun.TOML.parse(text);
            expect(parsed).toEqual({
              install: {
                registry: {
                  url: "https://registry.test/",
                  username: "$LANDO_NPM_BASIC_USERNAME",
                  password: "$LANDO_NPM_BASIC_PASSWORD",
                },
                scopes: {
                  "@acme": {
                    url: "https://registry.test/",
                    username: "$LANDO_NPM_BASIC_USERNAME",
                    password: "$LANDO_NPM_BASIC_PASSWORD",
                  },
                },
              },
            });
            if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
            expect(text + JSON.stringify(cmd)).not.toContain(password);
            expect(cmd).not.toContain("--registry");
            expect(env.LANDO_NPM_BASIC_PASSWORD).toBe(password);
            expect(env.LANDO_NPM_BASIC_USERNAME).toBe("alice");
            expect(env.BUN_CONFIG_TOKEN).toBeUndefined();
            expect(env.BUN_CONFIG_REGISTRY).toBeUndefined();
            return { exitCode };
          }),
        ),
      ),
    );

    expect(result.exitCode).toBe(exitCode);
    expect(await Bun.file(path).exists()).toBe(false);
  },
);

test("Basic config is finalized after process failure", async () => {
  let path = "";
  const config = parseNpmRegistryConfig("//registry.test/:_auth=YWxpY2U6c2VjcmV0");
  const credential = config.credentialFor("https://registry.test/", "https://registry.test/");
  if (credential === undefined) throw new Error("Missing test credential");

  const result = await Effect.runPromiseExit(
    publishWithCredential(
      credential,
      { registry: "https://registry.test/", packageName: "plugin", tag: "latest" },
      { output: "quiet" },
    ).pipe(
      withProcess(async ({ cmd }) => {
        path = cmd.find((value) => value.startsWith("--config="))?.slice(9) ?? "";
        throw new Error("child failed");
      }),
    ),
  );

  expect(result._tag).toBe("Failure");
  expect(path).not.toBe("");
  expect(await Bun.file(path).exists()).toBe(false);
});

test("Basic config is finalized after cancellation", async () => {
  const credential = parseNpmRegistryConfig("//registry.test/:_auth=YWxpY2U6c2VjcmV0").credentialFor(
    "https://registry.test/",
    "https://registry.test/",
  );
  if (credential === undefined) throw new Error("Missing test credential");
  const observed = Promise.withResolvers<string>();
  const controller = new AbortController();

  const pending = Effect.runPromiseExit(
    publishWithCredential(
      credential,
      { registry: "https://registry.test/", packageName: "plugin", tag: "latest" },
      { output: "quiet" },
    ).pipe(
      withProcess(async ({ cmd, signal }) => {
        const path = cmd.find((value) => value.startsWith("--config="))?.slice(9) ?? "";
        return await new Promise<{ exitCode: number }>((resolve) => {
          signal.addEventListener("abort", () => resolve({ exitCode: 143 }), { once: true });
          observed.resolve(path);
        });
      }),
    ),
    { signal: controller.signal },
  );
  const path = await observed.promise;
  controller.abort();
  const result = await pending;

  expect(result._tag).toBe("Failure");
  expect(path).not.toBe("");
  expect(await Bun.file(path).exists()).toBe(false);
});
