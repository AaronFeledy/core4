import { win32 } from "node:path";
import type { ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

const PRIVATE_FILE_PATH_ENV = "LANDO_PRIVATE_FILE_PATH";
const POWERSHELL_RELATIVE_PATH = ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"] as const;

const ACL_SCRIPT_HEADER = `
$ErrorActionPreference = 'Stop'
$path = [Environment]::GetEnvironmentVariable('${PRIVATE_FILE_PATH_ENV}', 'Process')
if ([String]::IsNullOrWhiteSpace($path)) { throw 'Missing private file path.' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
`.trim();

const ACL_SCRIPT_ASSERTIONS = `
$actual = [IO.File]::GetAccessControl($path, [Security.AccessControl.AccessControlSections]::Access)
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'Private file ACL is not exclusive.' }
$actualRule = $rules[0]
if ($actualRule.IdentityReference.Value -ne $sid.Value -or $actualRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or ($actualRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Private file ACL does not grant only the current user.' }
`.trim();

export const OWNER_ONLY_FILE_ACL_SCRIPT = `
${ACL_SCRIPT_HEADER}
$acl = New-Object Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
$acl.SetAccessRule($rule)
[IO.File]::SetAccessControl($path, $acl)
${ACL_SCRIPT_ASSERTIONS}
`.trim();

export const VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT = `
${ACL_SCRIPT_HEADER}
${ACL_SCRIPT_ASSERTIONS}
`.trim();

export type PrivateFileAccessProcessRunner = Pick<Context.Tag.Service<typeof ProcessRunner>, "run">;
export type OwnerOnlyFileAccess = (path: string) => Promise<void>;

export interface PrivateFileAccess {
  readonly enforce: OwnerOnlyFileAccess;
  readonly verify: OwnerOnlyFileAccess;
}

export interface OwnerOnlyFileAccessOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly processRunner?: PrivateFileAccessProcessRunner;
}

export class PrivateFileAccessError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Failed to verify private file access: ${path}`);
    this.name = "PrivateFileAccessError";
    this.path = path;
  }
}

const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

export const makeOwnerOnlyFileAccess = (options: OwnerOnlyFileAccessOptions = {}): PrivateFileAccess => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = async (path: string, script: string): Promise<void> => {
    if (platform !== "win32") return;
    const systemRoot = env.SystemRoot ?? env.WINDIR;
    if (systemRoot === undefined || !win32.isAbsolute(systemRoot) || options.processRunner === undefined) {
      throw new PrivateFileAccessError(path);
    }
    const result = await Effect.runPromise(
      options.processRunner
        .run({
          cmd: win32.join(systemRoot, ...POWERSHELL_RELATIVE_PATH),
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedCommand(script),
          ],
          env: { [PRIVATE_FILE_PATH_ENV]: path },
        })
        .pipe(Effect.mapError(() => new PrivateFileAccessError(path))),
    );
    if (result.exitCode !== 0) throw new PrivateFileAccessError(path);
  };
  return {
    enforce: (path) => run(path, OWNER_ONLY_FILE_ACL_SCRIPT),
    verify: (path) => run(path, VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT),
  };
};

export const enforceOwnerOnlyFileAccess = (
  path: string,
  options: OwnerOnlyFileAccessOptions = {},
): Promise<void> => makeOwnerOnlyFileAccess(options).enforce(path);

export const verifyOwnerOnlyFileAccess = (
  path: string,
  options: OwnerOnlyFileAccessOptions = {},
): Promise<void> => makeOwnerOnlyFileAccess(options).verify(path);
