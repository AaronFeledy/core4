import { onTestFinished } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { HOST_PROXY_CALL_COMMAND, HostProxyCall } from "../../../src/cli/host-proxy/call-context";
import { hostProxyChildEnv } from "../../../src/cli/host-proxy/call-spawn";

export const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-hp-call-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
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

export const sourceEntry = resolve(import.meta.dir, "../../../bin/lando.ts");
export const observedEntry = resolve(import.meta.dir, "call-test-entry.ts");
export const invoke = async (
  call: HostProxyCall,
  paths: Awaited<ReturnType<typeof fixture>>["paths"],
  entry = sourceEntry,
) => {
  const proc = Bun.spawn(
    [
      process.execPath,
      entry,
      HOST_PROXY_CALL_COMMAND,
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
