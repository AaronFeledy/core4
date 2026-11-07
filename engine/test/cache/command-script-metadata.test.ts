import { expect, test } from "bun:test";
import type { DiscoveredBunShellScript } from "@lando/landofile/bun-sh-discovery";
import { BunShellScriptFrontMatterError } from "@lando/sdk/errors";
import { compileBunShellScriptCommands } from "../../src/cache/command-compiler.ts";

const script = (frontMatter: DiscoveredBunShellScript["frontMatter"]): DiscoveredBunShellScript => ({
  id: "app:probe",
  name: "probe",
  path: "/app/.lando/scripts/probe.bun.sh",
  relativePath: "probe.bun.sh",
  summary: "Probe inputs",
  service: ":host",
  frontMatter,
});

test("projects declared script inputs in normalized order when compiling the index", () => {
  // Given
  const discovered = script({
    flags: { loud: { boolean: true }, name: { alias: "n", default: "world" } },
    args: { suffix: { order: 1 }, target: { order: 0, required: true } },
    disabled: true,
  });
  // When
  const entries = compileBunShellScriptCommands([discovered]);
  // Then
  expect(entries).toMatchObject([
    {
      id: "app:probe",
      summary: "Probe inputs",
      service: ":host",
      source: "bun-script",
      hidden: true,
      input: {
        flags: [
          { name: "loud", boolean: true, required: false },
          { name: "name", alias: "n", default: "world", boolean: false, required: false },
        ],
        args: [
          { name: "target", order: 0, required: true },
          { name: "suffix", order: 1, required: false },
        ],
      },
    },
  ]);
});

test.each([{}, { flags: {}, args: {} }])(
  "publishes an explicit raw script declaration when declarations are %j",
  (metadata) => {
    // Given / When
    const [entry] = compileBunShellScriptCommands([script(metadata)]);
    // Then
    expect(entry?.input).toMatchObject({
      flags: [],
      args: [],
      acceptsArguments: true,
      revision: expect.any(String),
    });
  },
);

test("preserves the adapter's typed error when script declarations are semantically invalid", () => {
  // Given
  const discovered = script({ flags: { name: { required: true, default: "invalid" } } });
  // When / Then
  expect(() => compileBunShellScriptCommands([discovered])).toThrow(BunShellScriptFrontMatterError);
});
