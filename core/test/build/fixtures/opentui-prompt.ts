import { resolve } from "node:path";

const terminateWindowsProcessTree = async (pid: number): Promise<void> => {
  const taskkill = Bun.spawn({
    cmd: ["taskkill.exe", "/PID", String(pid), "/T", "/F"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    taskkill.exited,
    new Response(taskkill.stdout).text(),
    new Response(taskkill.stderr).text(),
  ]);
  const detail = `${stderr}${stdout}`;
  // 0 = killed; 128 = process already gone (classic). Windows also returns 255 with
  // "There is no running instance of the task." when the tree races to exit first.
  const alreadyGone =
    exitCode === 128 || (exitCode === 255 && /no running instance of the task/i.test(detail));
  if (exitCode !== 0 && !alreadyGone) {
    throw new Error(
      `Failed to terminate Windows PTY process tree ${String(pid)} (exit ${String(exitCode)}): ${detail}`,
    );
  }
};

const closeSpawnStdin = async (proc: { readonly stdin: { end(): unknown } }): Promise<void> => {
  try {
    await proc.stdin.end();
  } catch {
    // Already closed when the child exited or was taskkilled.
  }
};

export const runPrompt = async (
  command: ReadonlyArray<string>,
  cwd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  let output = "";
  if (process.platform === "win32") {
    const winpty = resolve(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/winpty.exe");
    if (!(await Bun.file(winpty).exists())) throw new Error(`Missing Git for Windows PTY helper: ${winpty}`);
    const proc = Bun.spawn({
      cmd: [winpty, "-Xallow-non-tty", ...command, ...args],
      cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const consumeOutput = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      let text = "";
      for await (const chunk of stream) {
        const decoded = new TextDecoder().decode(chunk);
        text += decoded;
        output += decoded;
      }
      return text;
    };
    const stdout = consumeOutput(proc.stdout);
    const stderr = consumeOutput(proc.stderr);
    let exited = false;
    const completion = proc.exited.then((code) => {
      exited = true;
      return code;
    });
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (exited || output.includes("╭") || output.includes("(value or index):")) break;
      await Bun.sleep(20);
    }
    try {
      if (!exited) await terminateWindowsProcessTree(proc.pid);
    } catch (cause) {
      proc.kill();
      await proc.exited;
      await closeSpawnStdin(proc);
      throw cause;
    }
    await completion;
    await closeSpawnStdin(proc);
    output = `${await stdout}${await stderr}`;
  } else {
    const proc = Bun.spawn({
      cmd: [...command, ...args],
      cwd,
      env,
      terminal: {
        cols: 100,
        rows: 30,
        data: (_terminal, data) => {
          output += new TextDecoder().decode(data);
        },
      },
    });
    let exited = false;
    const completion = proc.exited.then((code) => {
      exited = true;
      return code;
    });
    try {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (exited || output.includes("╭") || output.includes("(value or index):")) break;
        await Bun.sleep(20);
      }
    } finally {
      proc.terminal?.close();
      if (!exited) proc.kill("SIGKILL");
      await completion;
    }
  }
  return output.replaceAll("\r\n", "\n");
};
