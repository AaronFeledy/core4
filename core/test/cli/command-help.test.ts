import { describe, expect, test } from "bun:test";

import { resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { renderCommandHelp, renderToolingHelp } from "../../src/cli/cli-help.ts";
import { shouldStyleHelp } from "../../src/cli/help-style.ts";

const requireBuiltIn = (token: string) => {
  const entry = resolveBuiltInCommand(token);
  if (entry === undefined) throw new Error(`expected built-in command ${token}`);
  return entry;
};

const sectionBody = (text: string, heading: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.length === 0 && body.length > 0) break;
    if (line.length > 0 && line === line.toUpperCase() && !line.startsWith(" ")) break;
    body.push(line);
  }
  return body.join("\n");
};

const flagRows = (text: string): ReadonlyArray<string> =>
  sectionBody(text, "FLAGS")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--"));

describe("renderCommandHelp", () => {
  test("omits the $ prefix from USAGE when rendering start", () => {
    // Given the registered start command
    const entry = requireBuiltIn("start");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then the usage line is a typeable invocation without a shell prompt
    expect(help).toContain("lando start");
    expect(help).not.toContain("$ lando");
    expect(typeof help).toBe("string");
  });

  test("uses the typeable name in USAGE instead of the canonical id", () => {
    // Given app:start, whose typeable name is start
    const entry = requireBuiltIn("app:start");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then USAGE names the alias you type
    expect(sectionBody(help, "USAGE")).toContain("lando start");
    expect(sectionBody(help, "USAGE")).not.toContain("app:start");
  });

  test("lists only extra names under ALIASES", () => {
    // Given start, whose primary typeable name is already in USAGE
    const entry = requireBuiltIn("start");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then ALIASES does not repeat the USAGE name
    const aliases = sectionBody(help, "ALIASES")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    expect(aliases).toContain("app:start");
    expect(aliases).not.toContain("start");
  });

  test("omits universal format and json flags from FLAGS rows", () => {
    // Given plugin:add, which has command-specific flags plus injected universals
    const entry = requireBuiltIn("plugin:add");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then FLAGS lists command flags only
    const rows = flagRows(help);
    expect(rows.some((row) => row.startsWith("--force"))).toBe(true);
    expect(rows.some((row) => row.startsWith("--trust"))).toBe(true);
    expect(rows.some((row) => row.startsWith("--format"))).toBe(false);
    expect(rows.some((row) => row.startsWith("--json"))).toBe(false);
  });

  test("appends the global-flags footer on every command page", () => {
    // Given a command with no command-specific flags
    const entry = requireBuiltIn("start");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then the locked footer points at the universal flags
    expect(help).toContain("Global flags (--format, --json, --renderer) work on every command.");
  });

  test("renders spec.examples when the command declares them", () => {
    // Given a command help source that includes examples
    const entry = {
      spec: {
        id: "app:example",
        summary: "Example command.",
        topLevelAlias: true,
        examples: ["lando example --watch", "lando example ./src"] as const,
      },
      status: { kind: "implemented" as const },
    };

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then each example appears under EXAMPLES
    const examples = sectionBody(help, "EXAMPLES");
    expect(examples).toContain("lando example --watch");
    expect(examples).toContain("lando example ./src");
  });

  test("keeps the deferred STATUS block", () => {
    // Given a deferred built-in
    const entry = requireBuiltIn("plugin:login");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then the planned-phase STATUS block is still present
    expect(sectionBody(help, "STATUS")).toContain("Planned for Lando 4.1.");
  });

  test("omits STATUS when the command is implemented", () => {
    // Given an implemented command
    const entry = requireBuiltIn("start");

    // When per-command help is rendered
    const help = renderCommandHelp(entry);

    // Then there is no STATUS heading
    expect(help).not.toContain("\nSTATUS\n");
    expect(help.startsWith("STATUS\n")).toBe(false);
  });
});

describe("renderToolingHelp", () => {
  test("renders summary, typeable usage, extras, and service when present", () => {
    // Given a cache-shaped tooling entry with a service
    const entry = { id: "app:greet", summary: "Echo hello", hidden: false, service: "appserver" };

    // When tooling help is rendered
    const help = renderToolingHelp(entry);

    // Then the page uses the typeable name and names the service
    expect(help).toContain("Echo hello");
    expect(help).toContain("lando greet [args...]");
    expect(help).not.toContain("$ lando");
    expect(sectionBody(help, "ALIASES")).toContain("app:greet");
    expect(help).toContain("Runs in service appserver");
    expect(typeof help).toBe("string");
  });

  test("omits the service line when the cache entry has no service", () => {
    // Given a tooling entry without a service
    const entry = { id: "app:greet", summary: "Echo hello" };

    // When tooling help is rendered
    const help = renderToolingHelp(entry);

    // Then the service sentence is absent
    expect(help).not.toContain("Runs in service");
  });

  test("uses a custom alias as the typeable usage name", () => {
    // Given a tooling id remapped by commandAliases.custom
    const entry = { id: "app:greet", summary: "Echo hello" };

    // When tooling help is rendered with that policy
    const help = renderToolingHelp(entry, { aliasPolicy: { custom: { hi: "app:greet" } } });

    // Then USAGE shows the custom token and extras keep the other names
    expect(sectionBody(help, "USAGE")).toContain("lando hi [args...]");
    const aliases = sectionBody(help, "ALIASES");
    expect(aliases).toContain("greet");
    expect(aliases).toContain("app:greet");
    expect(aliases.split(",").map((token) => token.trim())).not.toContain("hi");
  });
});

describe("command help color", () => {
  test("includes SGR when style is forced on", () => {
    // Given start help with style forced
    const entry = requireBuiltIn("start");

    // When the helper renders a styled page
    const help = renderCommandHelp(entry, { styled: true });

    // Then the returned string carries CSI bytes around headings or tokens
    expect(help).toContain("\x1b[");
    expect(typeof help).toBe("string");
  });

  test("omits SGR when style is off", () => {
    // Given start help with style forced off
    const entry = requireBuiltIn("start");

    // When the helper renders an unstyled page
    const help = renderCommandHelp(entry, { styled: false });

    // Then the page is plain text
    expect(help).not.toContain("\x1b[");
  });

  test("follows shouldStyleHelp for NO_COLOR", () => {
    // Given the same style gate the helpers must honor
    const styled = shouldStyleHelp({
      isTTY: true,
      env: { NO_COLOR: "1" },
      argv: [],
      rendererMode: "lando",
    });

    // When command help uses that decision
    const help = renderCommandHelp(requireBuiltIn("start"), { styled });

    // Then NO_COLOR suppresses CSI
    expect(styled).toBe(false);
    expect(help).not.toContain("\x1b[");
  });
});
