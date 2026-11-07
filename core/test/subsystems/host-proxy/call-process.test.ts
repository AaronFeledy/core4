import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { captureHostExecutionContext } from "@lando/engine/services/host-execution-context";
import { Effect, Schema } from "effect";
import { HostProxyCall } from "../../../src/cli/host-proxy/call-context";
import { hostProxyChildEnv } from "../../../src/cli/host-proxy/call-spawn";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-hp-call-"));
  roots.push(root);
  const appRoot = join(root, "app");
  const paths = {
    userConfRoot: join(root, "conf"),
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
    systemPluginRoot: join(root, "plugins"),
    platform: "linux" as const,
  };
  await Promise.all(
    [appRoot, ...Object.values(paths).filter((value) => value !== "linux")].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(join(appRoot, ".lando.yml"), "name: demo\nservices:\n  appserver:\n    type: node:22\n");
  const call = Schema.decodeUnknownSync(HostProxyCall.members[0])({
    operation: "runLando",
    argv: ["app:open", "--help"],
    env: {},
    app: { kind: "user", id: "demo", root: appRoot },
    mount: { containerRoot: "/app", hostRoot: appRoot },
    cwd: "/app",
    callId: "call-test",
    depth: 0,
    callerService: "web",
  });
  return { root, paths, call };
};
const sourceEntry = resolve(import.meta.dir, "../../../bin/lando.ts");
const invoke = async (
  call: HostProxyCall,
  paths: Awaited<ReturnType<typeof fixture>>["paths"],
  entry = sourceEntry,
) => {
  const proc = Bun.spawn(
    [
      process.execPath,
      entry,
      "__internal:host-proxy-call",
      ...(entry === sourceEntry ? [] : ["--test-events", join(paths.userDataRoot, "events.jsonl")]),
    ],
    {
      cwd: call.app.root,
      env: hostProxyChildEnv(process.env, paths, {}, call.depth),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    proc.stdin.write(`${JSON.stringify(call)}\n`);
    await proc.stdin.flush();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    proc.kill();
    await proc.exited;
  }
};

test.each(
  [
    ["destroy"],
    ["__internal:host-proxy-worker"],
    ["__internal:host-proxy-call"],
    ["help"],
    ["help", "destroy"],
    ["help", "app"],
    ["help", "plugin"],
    ["--version"],
    ["version"],
    ["open", "--version"],
    ["app:open", "-v"],
    ["--format=json", "destroy"],
    ["app", "--help"],
    ["plugin", "-h"],
  ].map((argv) => ({ argv })),
)("child denies non-allowlisted or internal argv %j", async ({ argv }) => {
  const { call, paths } = await fixture();
  const result = await invoke({ ...call, argv: [...argv, "--format=json"] }, paths);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout).error._tag).toBe("HostProxyCommandNotAllowedError");
});

test("child publishes redacted pre/post execution hooks on command failure", async () => {
  const { call, paths } = await fixture();
  await writeFile(join(call.app.root, ".lando.yml"), "name: demo\n");
  const result = await invoke(
    { ...call, argv: ["app:open", "--print", "--format=json"], callerService: "web" },
    paths,
    resolve(import.meta.dir, "call-test-entry.ts"),
  );
  const events = (await readFile(join(paths.userDataRoot, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(result.exitCode).not.toBe(0);
  expect(
    events
      .filter((event) => event._tag !== undefined)
      .map((event) => [event._tag, event.callId, event.depth, event.outcome]),
  ).toEqual([
    ["pre-host-proxy-call", "call-test", 0, undefined],
    ["post-host-proxy-call", "call-test", 0, "failure"],
  ]);
});

test.each(
  [
    ["open", "--help"],
    ["app:open", "--help"],
    ["help", "open"],
    ["--format=text", "open", "--help"],
  ].map((argv) => ({ argv })),
)("child renders allowlisted help argv %j", async ({ argv }) => {
  const { call, paths } = await fixture();
  const result = await invoke({ ...call, argv }, paths);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBeGreaterThan(0);
});

test.each(["symlink", "nested"] as const)("child rejects %s app retargeting", async (kind) => {
  const { call, paths, root } = await fixture();
  const target = kind === "symlink" ? join(root, "foreign") : join(call.app.root, "nested");
  await mkdir(target);
  await writeFile(join(target, ".lando.yml"), "name: foreign\n");
  if (kind === "symlink") await symlink(target, join(call.app.root, "nested"));
  const result = await invoke({ ...call, cwd: "/app/nested", argv: ["app:open", "--format=json"] }, paths);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout).error._tag).toBe("HostProxyCommandNotAllowedError");
});

test("container escape falls back to the session root", async () => {
  const { call, paths } = await fixture();
  const result = await invoke({ ...call, cwd: "/etc", argv: ["app:open", "--help"] }, paths);
  expect(result.exitCode).toBe(0);
});

test("malformed child input fails with a fixed diagnostic without reflecting its payload", async () => {
  const { paths } = await fixture();
  const secret = "child-envelope-credential-canary";
  const proc = Bun.spawn([process.execPath, sourceEntry, "__internal:host-proxy-call"], {
    env: hostProxyChildEnv(process.env, paths, {}, 0),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(`${JSON.stringify({ secret })}\n`);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stdout + stderr).not.toContain(secret);
  expect(stdout + stderr).toContain("Invalid host-proxy call input.");
});

test.each([false, true])("child rejects an open alias routed to tooling (help=%s)", async (help) => {
  const { call, paths } = await fixture();
  await writeFile(
    join(call.app.root, ".lando.yml"),
    "name: demo\ncommandAliases:\n  custom:\n    open: app:greet\n",
  );
  await mkdir(join(call.app.root, ".lando/scripts"), { recursive: true });
  await writeFile(
    join(call.app.root, ".lando/scripts/greet.bun.sh"),
    "# ---\n# desc: Greet\n# ---\necho escaped\n",
  );
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: { name: "demo", commandAliases: { custom: { open: "app:greet" } } },
      entries: [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }],
      cwd: call.app.root,
      cacheRoot: paths.userCacheRoot,
    }),
  );
  const result = await invoke(
    { ...call, argv: ["open", "--format=json", ...(help ? ["--help"] : [])] },
    paths,
  );
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stdout).error._tag).toBe("HostProxyCommandNotAllowedError");
  expect(result.stdout).not.toContain("escaped");
});

test("effective child environment excludes container roots, session values, and Bun mode flags", async () => {
  const { paths } = await fixture();
  const env = hostProxyChildEnv(
    { ...process.env, BUN_BE_BUN: "1", BUN_FEATURE_FLAG_NO_ORPHANS: "1", LANDO_HOST_PROXY_TOKEN: "secret" },
    paths,
    {
      LANDO_USER_DATA_ROOT: "/foreign",
      LANDO_PROVIDER: "evil",
      BUN_BE_BUN: "1",
      TERM: "vt100",
      OPENCODE: "1",
    },
    1,
  );
  const effective = captureHostExecutionContext(
    { env, replaceEnv: true },
    {
      cwd: process.cwd(),
      env: { LANDO_HOST_PROXY_SESSION: "secret", BUN_BE_BUN: "1" },
      platform: process.platform,
    },
  ).env;
  const proc = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"], {
    env: effective,
    stdout: "pipe",
    stderr: "pipe",
  });
  const observed = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(observed.LANDO_USER_DATA_ROOT).toBe(paths.userDataRoot);
  expect(observed.LANDO_PROVIDER).toBeUndefined();
  expect(observed.BUN_BE_BUN).toBeUndefined();
  expect(observed.BUN_FEATURE_FLAG_NO_ORPHANS).toBeUndefined();
  expect(observed.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
  expect(observed.LANDO_HOST_PROXY_SESSION).toBeUndefined();
  expect(observed.LANDO_HOST_PROXY_DEPTH).toBe("2");
  expect(observed.TERM).toBe("vt100");
});

test("child aborts active invocation when its worker stdin lease closes", async () => {
  const { call, root } = await fixture();
  const entry = join(root, "lease.ts");
  await writeFile(
    entry,
    `import {runHostProxyCallProcess} from ${JSON.stringify(resolve(import.meta.dir, "../../../src/cli/host-proxy/call-runtime.ts"))}; await runHostProxyCallProcess(async (_, signal) => { process.stdout.write("ready\\n"); await new Promise(resolve => signal.addEventListener("abort", resolve, {once:true})); process.stdout.write("aborted\\n"); });`,
  );
  const proc = Bun.spawn([process.execPath, entry], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    proc.stdin.write(`${JSON.stringify(call)}\n`);
    await proc.stdin.flush();
    const reader = proc.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    await proc.stdin.end();
    let output = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }
    expect(output).toContain("aborted");
    expect(await proc.exited).toBe(0);
  } finally {
    proc.kill();
    await proc.exited;
  }
});
