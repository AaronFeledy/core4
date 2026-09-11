import { win32 } from "node:path";
import { Schema } from "effect";

const POWERSHELL_RELATIVE_PATH = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"] as const;
const MAX_RESPONSE_BYTES = 4_096;

const ACL_ASSERTIONS = `
$actual = [IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'Private file ACL is not exclusive.' }
$actualRule = $rules[0]
if ($actualRule.IdentityReference.Value -ne $sid.Value -or $actualRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $actualRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $actualRule.IsInherited -or $actualRule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None -or $actualRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'Private file ACL does not grant exactly FullControl to only the current user.' }
`.trim();

export const OWNER_ONLY_FILE_ACL_BODY = `
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
$acl.SetAccessRule($rule)
[IO.File]::SetAccessControl($path, $acl)
${ACL_ASSERTIONS}
`.trim();

export const VERIFY_OWNER_ONLY_FILE_ACL_BODY = ACL_ASSERTIONS;

export const OWNER_ONLY_FILE_ACL_WORKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = [string]$request.id
    $path = [string]$request.path
    $operation = [string]$request.operation
    if ([String]::IsNullOrWhiteSpace($id) -or [String]::IsNullOrWhiteSpace($path)) { throw 'Invalid private file request.' }
    if ($operation -eq 'enforce') {
      ${OWNER_ONLY_FILE_ACL_BODY}
    } elseif ($operation -eq 'verify') {
      ${VERIFY_OWNER_ONLY_FILE_ACL_BODY}
    } else {
      throw 'Invalid private file operation.'
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false } | ConvertTo-Json -Compress))
  }
}
`.trim();

export interface PrivateFileAccessProcess {
  readonly stdin: {
    readonly write: (data: string | Uint8Array) => number | Promise<number>;
    readonly flush: () => number | Promise<number>;
    readonly end: () => number | Promise<number>;
  };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly kill: () => void;
}

export interface PrivateFileAccessSpawnOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type PrivateFileAccessSpawn = (
  command: ReadonlyArray<string>,
  options: PrivateFileAccessSpawnOptions,
) => PrivateFileAccessProcess;

export interface PrivateFileAccessWorkerOptions {
  readonly systemRoot: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: PrivateFileAccessSpawn;
}

type WorkerOperation = "enforce" | "verify";
interface ByteReader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value: Uint8Array | undefined }>;
}

const WorkerResponse = Schema.Struct({ id: Schema.String, ok: Schema.Boolean });
const decodeResponse = Schema.decodeUnknownSync(WorkerResponse, { onExcessProperty: "error" });
const encodedCommand = Buffer.from(OWNER_ONLY_FILE_ACL_WORKER_SCRIPT, "utf16le").toString("base64");

const readLine = async (reader: ByteReader, state: { buffer: string }): Promise<string> => {
  const decoder = new TextDecoder();
  for (;;) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline).replace(/\r$/u, "");
      state.buffer = state.buffer.slice(newline + 1);
      return line;
    }
    const next = await reader.read();
    if (next.done || next.value === undefined) {
      throw new TypeError("Private file ACL worker exited before responding.");
    }
    state.buffer += decoder.decode(next.value, { stream: true });
    if (state.buffer.length > MAX_RESPONSE_BYTES) {
      throw new TypeError("Private file ACL worker response exceeded the protocol limit.");
    }
  }
};

export const makePrivateFileAccessWorker = (options: PrivateFileAccessWorkerOptions) => {
  let processHandle: PrivateFileAccessProcess | undefined;
  let reader: ByteReader | undefined;
  let stderrDrained: Promise<void> | undefined;
  const lineState = { buffer: "" };
  let sequence = 0;
  let queue = Promise.resolve();
  let closed = false;

  const closeProcess = async (): Promise<void> => {
    const current = processHandle;
    processHandle = undefined;
    reader = undefined;
    lineState.buffer = "";
    if (current === undefined) return;
    if (current.exitCode === null) current.kill();
    await current.exited;
    await stderrDrained;
    stderrDrained = undefined;
  };

  const start = (): PrivateFileAccessProcess => {
    const child = options.spawn(
      [
        win32.join(options.systemRoot, ...POWERSHELL_RELATIVE_PATH),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedCommand,
      ],
      { env: options.env },
    );
    processHandle = child;
    reader = child.stdout.getReader();
    stderrDrained = (async () => {
      const stderr = child.stderr.getReader();
      for (;;) {
        const next = await stderr.read();
        if (next.done) return;
      }
    })().then(
      () => undefined,
      () => undefined,
    );
    return child;
  };

  const execute = async (operation: WorkerOperation, path: string): Promise<void> => {
    if (closed) throw new TypeError("Private file ACL worker is closed.");
    const child = processHandle?.exitCode === null ? processHandle : start();
    const stdout = reader;
    if (stdout === undefined) throw new TypeError("Private file ACL worker stdout is unavailable.");
    sequence += 1;
    const id = String(sequence);
    try {
      await child.stdin.write(`${JSON.stringify({ id, operation, path })}\n`);
      await child.stdin.flush();
      const result = await Promise.race([
        readLine(stdout, lineState).then((line) => ({ kind: "response" as const, line })),
        child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
      ]);
      if (result.kind === "exit")
        throw new TypeError(`Private file ACL worker exited with ${result.exitCode}.`);
      const response = decodeResponse(JSON.parse(result.line));
      if (response.id !== id || !response.ok)
        throw new TypeError("Private file ACL worker rejected the request.");
    } catch (cause) {
      await closeProcess();
      throw cause;
    }
  };

  const run = (operation: WorkerOperation, path: string): Promise<void> => {
    if (closed) return Promise.reject(new TypeError("Private file ACL worker is closed."));
    const current = queue.then(() => execute(operation, path));
    queue = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  return {
    enforce: (path: string) => run("enforce", path),
    verify: (path: string) => run("verify", path),
    close: async () => {
      closed = true;
      await closeProcess();
      await queue;
    },
  };
};

export const bunPrivateFileAccessSpawn: PrivateFileAccessSpawn = (command, options) => {
  const child = Bun.spawn([...command], {
    env: { ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  return child;
};
