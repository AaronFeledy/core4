import { expect, test } from "bun:test";
import { type LandoPaths, makeLandoPaths } from "../src/paths.ts";

test("agentRelayRunDir is app- and kind-scoped under userDataRoot/run", () => {
  // Given: an isolated data root and two applications sharing a name.
  const paths: LandoPaths = makeLandoPaths({ platform: "linux", env: {}, userDataRoot: "/isolated/data" });
  // When: relay directories are derived for each agent kind and application.
  const ssh = paths.agentRelayRunDir("ssh", "My App!", "/work/a");
  const gpg = paths.agentRelayRunDir("gpg", "My App!", "/work/a");
  const other = paths.agentRelayRunDir("ssh", "My App!", "/work/b");
  // Then: the canonical app fingerprint is reused with a kind-specific suffix.
  expect(ssh).toBe(`${paths.hostProxyRunDir("My App!", "/work/a")}-ssh-agent`);
  expect(ssh).toMatch(/^\/isolated\/data\/run\/My-App-[a-f0-9]{12}-ssh-agent$/u);
  expect(gpg).toBe(`${paths.hostProxyRunDir("My App!", "/work/a")}-gpg-agent`);
  expect(other).not.toBe(ssh);
  expect(paths.agentRelayRunDir("ssh", "Another App", "/work/a")).not.toBe(ssh);
});
