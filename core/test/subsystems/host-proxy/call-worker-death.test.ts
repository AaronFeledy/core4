import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("worker death closes the lease and aborts its surviving child", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-hp-orphan-"));
  const call = {
    operation: "runLando",
    argv: ["app:open"],
    env: {},
    app: { kind: "user", id: "demo", root },
    mount: { containerRoot: "/app", hostRoot: root },
    cwd: "/app",
    callId: "lease",
    depth: 0,
    callerService: "web",
  };
  const childEntry = join(root, "orphan-call.ts");
  const workerEntry = join(root, "lease-owner.ts");
  await writeFile(
    childEntry,
    `import {runHostProxyCallProcess} from ${JSON.stringify(resolve(import.meta.dir, "../../../src/cli/host-proxy/call-runtime.ts"))}; await runHostProxyCallProcess(async (_, signal) => { process.stdout.write(JSON.stringify({pid:process.pid})+"\\n"); await new Promise(resolve => signal.addEventListener("abort",resolve,{once:true})); process.stdout.write("aborted\\n"); });`,
  );
  await writeFile(
    workerEntry,
    `const child=Bun.spawn([process.execPath,${JSON.stringify(childEntry)}],{stdin:"pipe",stdout:"inherit",stderr:"inherit"}); child.stdin.write(${JSON.stringify(`${JSON.stringify(call)}\n`)}); await child.stdin.flush(); await child.exited;`,
  );
  const worker = Bun.spawn([process.execPath, workerEntry], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = worker.stdout.getReader();
    const ready = await reader.read();
    const { pid } = JSON.parse(new TextDecoder().decode(ready.value).trim());
    worker.kill("SIGKILL");
    await worker.exited;
    let output = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      output += new TextDecoder().decode(next.value);
    }
    expect(output).toContain("aborted");
    if (process.platform === "linux") {
      try {
        process.kill(pid, 0);
        expect(await Bun.file(`/proc/${pid}/stat`).text()).toMatch(/\) Z /);
      } catch (cause) {
        expect(cause).toMatchObject({ code: expect.stringMatching(/^(ESRCH|ENOENT)$/) });
      }
    }
  } finally {
    worker.kill();
    await worker.exited;
    await rm(root, { recursive: true, force: true });
  }
});
