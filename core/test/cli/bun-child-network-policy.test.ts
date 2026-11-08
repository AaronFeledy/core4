import { expect, test } from "bun:test";
import { Effect } from "effect";
import { applyBunCaMode, resolveBunChildCaMode } from "../../src/cli/commands/bun-child-network-policy";

test.each([
  { argv: ["install", "--cafile", "/wrong.pem", "pkg"] },
  { argv: ["add", "--cafile=/wrong.pem", "pkg"] },
  { argv: ["publish", "--ca", "wrong-inline-ca", "--tag", "next"] },
] as const)("strict CA projection replaces both CA flag forms for %j", async ({ argv }) => {
  const input = { trustHost: false, hasCustomCa: true, bundlePath: "/trusted.pem", verb: argv[0], argv };

  const result = await Effect.runPromise(
    applyBunCaMode(
      { NODE_EXTRA_CA_CERTS: "/ambient.pem", NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      argv,
      resolveBunChildCaMode(input),
    ),
  );

  expect(result.argv.slice(0, 3)).toEqual([argv[0], "--cafile", "/trusted.pem"]);
  expect(result.argv).not.toContain("/wrong.pem");
  expect(result.argv).not.toContain("--cafile=/wrong.pem");
  expect(result.argv).not.toContain("wrong-inline-ca");
  expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  expect(result.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
});

test("strict Bun registry commands without a verified CA projection fail closed", async () => {
  const mode = resolveBunChildCaMode({
    trustHost: false,
    hasCustomCa: true,
    bundlePath: "/trusted.pem",
    verb: "pm",
    argv: ["pm", "view", "private-package"],
  });

  const error = await Effect.runPromise(Effect.flip(applyBunCaMode({}, ["pm", "view"], mode)));

  expect(error).toMatchObject({ _tag: "BunChildNetworkPolicyError", kind: "unsupported-strict-command" });
});

test("strict bunx rejects conflicting install overrides", async () => {
  const argv = ["x", "--install=force", "remote-binary"];
  const mode = resolveBunChildCaMode({
    trustHost: false,
    hasCustomCa: true,
    bundlePath: "/trusted.pem",
    verb: "x",
    argv,
  });

  const error = await Effect.runPromise(Effect.flip(applyBunCaMode({}, argv, mode)));

  expect(error).toMatchObject({ _tag: "BunChildNetworkPolicyError", kind: "unsupported-strict-bunx" });
});

test("default host trust preserves a caller's narrower explicit cafile", async () => {
  const argv = ["install", "--cafile", "/caller.pem"];

  const mode = resolveBunChildCaMode({ trustHost: true, hasCustomCa: false, verb: "install", argv });
  const result = await Effect.runPromise(applyBunCaMode({}, argv, mode));

  expect(result.argv).toEqual(argv);
});

test("strict bunx projection preserves every executable-owned argument", async () => {
  const argv = [
    "x",
    "local-tool",
    "--ca",
    "tool-cert.pem",
    "--cafile",
    "tool-file.pem",
    "--cafile=tool.pem",
    "--no-install",
    "--install",
    "force",
    "--install=force",
    "--",
    "",
  ];

  const result = await Effect.runPromise(applyBunCaMode({}, argv, { mode: "bunx-no-install" }));

  expect(result.argv).toEqual(["x", "--no-install", ...argv.slice(1)]);
});

test.each([
  { prefix: [] },
  { prefix: ["--"] },
  { prefix: ["-p", "fixture-package"] },
  { prefix: ["--package", "fixture-package"] },
  { prefix: ["--package=fixture-package"] },
] as const)("strict bunx allows tool install flags after executable prefix %j", ({ prefix }) => {
  const argv = ["x", ...prefix, "local-tool", "--install=force", "--install", "tool-value"];

  const mode = resolveBunChildCaMode({
    trustHost: false,
    hasCustomCa: true,
    bundlePath: "/trusted.pem",
    verb: "x",
    argv,
  });

  expect(mode).toEqual({ mode: "bunx-no-install" });
});

test.each([
  { argv: ["x", "-p", "fixture-package", "--install=force", "local-tool"] },
  { argv: ["x", "--package", "fixture-package", "--install", "force", "local-tool"] },
  { argv: ["x", "--package=fixture-package", "--install=force", "--", "local-tool"] },
] as const)("strict bunx still rejects Bun-owned install overrides in %j", async ({ argv }) => {
  const mode = resolveBunChildCaMode({
    trustHost: false,
    hasCustomCa: true,
    bundlePath: "/trusted.pem",
    verb: "x",
    argv,
  });

  const error = await Effect.runPromise(Effect.flip(applyBunCaMode({}, argv, mode)));

  expect(error).toMatchObject({ _tag: "BunChildNetworkPolicyError", kind: "unsupported-strict-bunx" });
});
