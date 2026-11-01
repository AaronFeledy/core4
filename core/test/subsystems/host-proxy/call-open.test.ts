import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppPlan, HostProxyResponse } from "@lando/sdk/schema";
import { Schema } from "effect";
import { hostProxyChildEnv } from "../../../src/cli/host-proxy/call-spawn";
import { makePlan } from "../../_support/host-proxy-open-fixtures";

test("one runtime-free worker serves fresh open children with current config, containment and execution hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-open-child-"));
  const paths = {
    platform: "linux" as const,
    userConfRoot: join(root, "conf"),
    userCacheRoot: join(root, "cache"),
    userDataRoot: join(root, "data"),
    systemPluginRoot: join(root, "plugins"),
  };
  await Promise.all(
    Object.values(paths)
      .filter((path) => path !== "linux")
      .map((path) => mkdir(path)),
  );
  const shim = join(root, "shim");
  await writeFile(shim, "fixture");
  await writeFile(join(root, "README"), "safe");
  await symlink("/etc/passwd", join(root, "escape"));
  const plan = { ...makePlan([], []), root };
  const log = join(root, "opens.jsonl");
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "call-open-test-entry.ts"), "__internal:host-proxy-worker"],
    {
      cwd: root,
      env: { ...hostProxyChildEnv(process.env, paths, {}, 0), LANDO_TEST_OPEN_LOG: log },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = new Response(proc.stderr).text();
  try {
    proc.stdin.write(
      JSON.stringify({
        app: { kind: "user", id: plan.id, root },
        plan: Schema.encodeUnknownSync(AppPlan)(plan),
        paths,
        shimArtifactPath: shim,
        configDigest: "test",
      }),
    );
    await proc.stdin.end();
    const reader = proc.stdout.getReader();
    const ready = await reader.read();
    if (ready.done) throw new TypeError(`Worker failed: ${await stderr}`);
    const session = JSON.parse(new TextDecoder().decode(ready.value));
    await reader.cancel();
    const invoke = (body: unknown, operation = "openUrl") =>
      new Promise<{ status: number; response: typeof HostProxyResponse.Type }>((resolveCall, reject) => {
        const req = request(
          {
            socketPath: session.socketPath,
            path: `/${operation}`,
            method: "POST",
            headers: {
              authorization: `Bearer ${session.token}`,
              "x-lando-host-proxy-app": session.appId,
              "x-lando-host-proxy-session": session.sessionId,
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.once("error", reject);
            res.once("end", () => {
              try {
                resolveCall({
                  status: res.statusCode ?? 0,
                  response: Schema.decodeUnknownSync(Schema.fromJsonString(HostProxyResponse))(data),
                });
              } catch (cause) {
                reject(cause);
              }
            });
          },
        );
        req.once("error", reject);
        req.end(JSON.stringify(body));
      });
    expect((await invoke({ _tag: "openUrl", url: "https://example.com/private-target" })).response).toEqual({
      _tag: "ok",
    });
    const denied = await invoke({ _tag: "openUrl", url: "custom:private-target" });
    expect(denied.status).toBe(403);
    expect(denied.response).toMatchObject({
      code: "scheme-not-allowed",
      remediation: `Allow this scheme with: lando config set hostProxy.allowedSchemes '["custom"]' --type=json`,
    });
    await writeFile(join(paths.userConfRoot, "config.yml"), "hostProxy:\n  allowedSchemes:\n    - CuStOm\n");
    expect((await invoke({ _tag: "openUrl", url: "CUSTOM:private-target" })).response).toEqual({
      _tag: "ok",
    });
    for (const url of ["file:///etc/passwd", "FILE:///etc/passwd"]) {
      expect((await invoke({ _tag: "openUrl", url })).response).toMatchObject({ code: "scheme-not-allowed" });
    }
    expect((await invoke({ _tag: "openPath", path: "/app/README" }, "openPath")).response).toEqual({
      _tag: "ok",
    });
    for (const path of ["/app/escape", "/etc/passwd", "/application/README"]) {
      expect((await invoke({ _tag: "openPath", path }, "openPath")).response).toMatchObject({
        code: "command-not-allowed",
      });
    }
    await writeFile(join(paths.userConfRoot, "config.yml"), "hostProxy:\n  allowedSchemes:\n    - FILE\n");
    const invalid = await invoke({ _tag: "openUrl", url: "https://example.com" });
    expect(invalid.status).toBe(500);
    expect(invalid.response).toMatchObject({
      _tag: "error",
      code: "internal",
      remediation: expect.stringContaining("config.yml"),
    });
    await writeFile(join(paths.userConfRoot, "config.yml"), "router: [invalid-private-config\n");
    expect((await invoke({ _tag: "openUrl", url: "https://example.com" })).response).toMatchObject({
      _tag: "error",
      code: "internal",
    });
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const opens = lines.filter((line) => line.opener !== undefined);
    expect(opens).toHaveLength(3);
    expect(new Set(opens.map((line) => line.pid)).size).toBe(3);
    expect(lines.every((line) => line.pid !== proc.pid)).toBe(true);
    const events = lines.flatMap((line) => (line.event === undefined ? [] : [line.event]));
    expect(events.filter((event) => event._tag === "pre-host-proxy-call")).toHaveLength(9);
    expect(events.filter((event) => event._tag === "post-host-proxy-call")).toHaveLength(9);
    expect(JSON.stringify(events)).not.toContain("private-target");
    expect(JSON.stringify(events)).not.toContain("/etc/passwd");
    expect(() => process.kill(proc.pid, 0)).not.toThrow();
  } finally {
    proc.kill();
    await proc.exited;
    await stderr;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("an open child cancels its opener and publishes the failure hook when its lease closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-open-lease-"));
  const log = join(root, "events.jsonl");
  const paths = {
    platform: "linux" as const,
    userConfRoot: root,
    userCacheRoot: root,
    userDataRoot: root,
    systemPluginRoot: root,
  };
  const proc = Bun.spawn(
    [process.execPath, resolve(import.meta.dir, "call-open-test-entry.ts"), "__internal:host-proxy-call"],
    {
      cwd: root,
      env: { ...hostProxyChildEnv(process.env, paths, {}, 0), LANDO_TEST_OPEN_LOG: log },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    proc.stdin.write(
      `${JSON.stringify({ operation: "openUrl", url: "https://example.com/wait", app: { kind: "user", id: "demo", root }, mount: { containerRoot: "/app", hostRoot: root }, cwd: "/app", callId: "open-lease", depth: 0, callerService: "web" })}\n`,
    );
    await proc.stdin.flush();
    const reader = proc.stderr.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("opener-ready");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    let stderr = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stderr += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    await proc.exited;
    const events = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .flatMap((line) => (line.event === undefined ? [] : [line.event]));
    expect(events.map((event) => [event._tag, event.outcome])).toEqual([
      ["pre-host-proxy-call", undefined],
      ["post-host-proxy-call", "failure"],
    ]);
    expect(stdout).not.toContain("example.com/wait");
    expect(stderr).not.toContain("example.com/wait");
    expect(() => process.kill(proc.pid, 0)).toThrow();
  } finally {
    proc.kill();
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
