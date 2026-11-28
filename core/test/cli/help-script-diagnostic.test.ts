import { expect, test } from "bun:test";
import { Schema } from "effect";
import { HelpCommandDescriptor } from "../../src/cli/help-command-descriptor.ts";

type Descriptor = Schema.Schema.Type<typeof HelpCommandDescriptor>;

const roundTrip = (descriptor: Descriptor): Descriptor =>
  Schema.decodeUnknownSync(HelpCommandDescriptor)(Schema.encodeSync(HelpCommandDescriptor)(descriptor));

const row = {
  canonicalId: "app:smoke",
  typeable: "app:smoke",
  extras: [],
  summary: "Unavailable script",
  source: "tooling" as const,
};

test("keeps located script findings in a published tooling loadError", () => {
  // Given a cached script diagnostic with two located issues
  const descriptor = {
    ...row,
    loadError: {
      _tag: "BunShellScriptFrontMatterError",
      message: "Invalid declarations",
      remediation: "Correct them.",
      issues: [
        { path: ["env", "SITE"], reason: "other-scope", message: "Reads another scope." },
        { path: ["engine"], reason: "unsupported-key", message: "Unsupported key." },
      ],
      omittedIssueCount: 0,
    },
  };
  // When / Then the help contract retains them
  const decoded = roundTrip(descriptor);
  if (decoded.source !== "tooling") throw new Error("expected a tooling row");
  expect(decoded.loadError).toMatchObject({
    issues: [
      { path: ["env", "SITE"], reason: "other-scope" },
      { path: ["engine"], reason: "unsupported-key" },
    ],
    omittedIssueCount: 0,
  });
});

test("keeps a plugin diagnostic's own fields", () => {
  // Given a plugin load error with winner and loser data
  const descriptor = {
    ...row,
    source: "plugin" as const,
    plugin: "owner",
    loadError: {
      _tag: "PluginLoadError",
      message: "Cannot load",
      remediation: "Repair it.",
      winner: { source: "bundled", pluginName: "owner" },
      loser: { source: "external", pluginName: "other" },
    },
  };
  // When / Then the union does not strip plugin fields
  const decoded = roundTrip(descriptor);
  if (decoded.source !== "plugin") throw new Error("expected a plugin row");
  expect(decoded.loadError).toEqual(descriptor.loadError);
});
