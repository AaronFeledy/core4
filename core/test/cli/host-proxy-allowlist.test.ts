import { describe, expect, test } from "bun:test";

import { HostProxyAllowlistConflictError } from "@lando/sdk/errors";

import type { LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../../src/cli/oclif/generated/host-proxy-allowlist.ts";
import {
  HOST_PROXY_ALLOWLIST_FORBIDDEN_IDS,
  assertHostProxyAllowlistSafe,
  computeHostProxyRunLandoAllowlist,
  isHostProxyAllowlistForbidden,
} from "../../src/cli/oclif/host-proxy-allowlist.ts";

const EXPECTED_ALLOWLIST = ["app:open"];

const liveSpecs = (): ReadonlyArray<LandoCommandSpec> =>
  Object.values(compiledCommands)
    .map((commandClass) => (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec)
    .filter((spec): spec is LandoCommandSpec => spec !== undefined);

describe("host-proxy allowlist forbidden-id guard", () => {
  test("flags every lifecycle command", () => {
    for (const id of [
      "app:start",
      "app:stop",
      "app:restart",
      "app:rebuild",
      "app:destroy",
      "apps:poweroff",
    ]) {
      expect(isHostProxyAllowlistForbidden(id)).toBe(true);
      expect(HOST_PROXY_ALLOWLIST_FORBIDDEN_IDS).toContain(id);
    }
  });

  test("flags meta:bun and meta:x", () => {
    expect(isHostProxyAllowlistForbidden("meta:bun")).toBe(true);
    expect(isHostProxyAllowlistForbidden("meta:x")).toBe(true);
  });

  test("does not flag app:open", () => {
    expect(isHostProxyAllowlistForbidden("app:open")).toBe(false);
  });
});

describe("assertHostProxyAllowlistSafe", () => {
  const makeSpec = (
    id: string,
    hostProxyAllowed: boolean | undefined,
  ): Pick<LandoCommandSpec, "id"> & { readonly hostProxyAllowed?: boolean } => ({ id, hostProxyAllowed });

  test("rejects a lifecycle command that self-allows", () => {
    expect(() => assertHostProxyAllowlistSafe(makeSpec("app:start", true))).toThrow(
      HostProxyAllowlistConflictError,
    );
    expect(() => assertHostProxyAllowlistSafe(makeSpec("app:destroy", true))).toThrow(
      HostProxyAllowlistConflictError,
    );
    expect(() => assertHostProxyAllowlistSafe(makeSpec("meta:bun", true))).toThrow(
      HostProxyAllowlistConflictError,
    );
  });

  test("allows a lifecycle command that does not self-allow", () => {
    expect(() => assertHostProxyAllowlistSafe(makeSpec("app:start", false))).not.toThrow();
    expect(() => assertHostProxyAllowlistSafe(makeSpec("app:start", undefined))).not.toThrow();
  });

  test("allows a safe command that self-allows", () => {
    expect(() => assertHostProxyAllowlistSafe(makeSpec("app:open", true))).not.toThrow();
  });
});

describe("host-proxy runLando allowlist derivation", () => {
  test("derives exactly the shipped opt-ins, sorted", () => {
    expect(computeHostProxyRunLandoAllowlist(liveSpecs())).toEqual(EXPECTED_ALLOWLIST);
  });

  test("the generated cache matches the live derivation (no drift)", () => {
    expect([...HOST_PROXY_RUNLANDO_ALLOWLIST]).toEqual(computeHostProxyRunLandoAllowlist(liveSpecs()));
  });

  test("app:open actually declares hostProxyAllowed", () => {
    const spec = liveSpecs().find((candidate) => candidate.id === "app:open");
    expect(spec?.hostProxyAllowed).toBe(true);
  });

  test("the freshness compare catches a removed allowlist entry", () => {
    const stripped = liveSpecs().filter((spec) => spec.id !== "app:open");
    const derived = computeHostProxyRunLandoAllowlist(stripped);
    expect(derived).toEqual([]);
    expect([...HOST_PROXY_RUNLANDO_ALLOWLIST]).not.toEqual(derived);
  });

  test("no forbidden id is in the generated allowlist", () => {
    for (const id of HOST_PROXY_RUNLANDO_ALLOWLIST) {
      expect(isHostProxyAllowlistForbidden(id)).toBe(false);
    }
  });
});
