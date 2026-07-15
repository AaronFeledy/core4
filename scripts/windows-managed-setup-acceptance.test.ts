import { describe, expect, test } from "bun:test";

import { classifyWindowsManagedSetupResult } from "./windows-managed-setup-acceptance.ts";

describe("Windows managed setup acceptance", () => {
  test("passes only when compiled setup exits successfully", () => {
    expect(classifyWindowsManagedSetupResult({ exitCode: 0, stdout: '{"ok":true}', stderr: "" })).toEqual({
      outcome: "passed",
      exitCode: 0,
    });
  });

  test("structured-skips the exact Windows virtualization prerequisite failure", () => {
    expect(
      classifyWindowsManagedSetupResult({
        exitCode: 2,
        stdout: "",
        stderr:
          '{"apiVersion":"v4","command":"meta:setup","ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required."}}',
      }),
    ).toEqual({
      outcome: "skipped",
      exitCode: 0,
      reason: "Windows virtualization prerequisites are not available on this runner.",
    });
  });

  test("fails a missing win-sshproxy helper instead of treating it as an environment skip", () => {
    expect(
      classifyWindowsManagedSetupResult({
        exitCode: 2,
        stdout: "",
        stderr:
          '{"ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Podman machine start failed because required helper win-sshproxy.exe was not found."}}',
      }),
    ).toEqual({
      outcome: "failed",
      exitCode: 1,
      reason: "Compiled Windows managed setup exited with code 2.",
    });
  });

  test("fails an unrelated terminal error even when earlier output names the prerequisite", () => {
    expect(
      classifyWindowsManagedSetupResult({
        exitCode: 2,
        stdout:
          '{"ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Windows virtualization prerequisites are not available. Hyper-V, WSL2, and Virtual Machine Platform are required."}}',
        stderr:
          '{"apiVersion":"v4","command":"meta:setup","ok":false,"error":{"_tag":"ProviderUnavailableError","message":"Podman machine start failed because required helper win-sshproxy.exe was not found."}}',
      }),
    ).toEqual({
      outcome: "failed",
      exitCode: 1,
      reason: "Compiled Windows managed setup exited with code 2.",
    });
  });
});
