import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { uninstall } from "../../src/operations/uninstall.ts";
import { makeUninstallRoots, sandboxUninstallOptions } from "./uninstall-support.ts";

test.each(["foreign", "missing", "unparseable", "mixed", "canonical", "quoted"] as const)(
  "purge respects shellenv data-root ownership: %s",
  async (scenario) => {
    const roots = makeUninstallRoots("lando-uninstall-shell-owner-");
    const foreignRoot = join(roots.root, "other-data");
    const alias = join(roots.root, "data-alias");
    mkdirSync(roots.userDataRoot, { recursive: true });
    symlinkSync(roots.userDataRoot, alias);
    const quote = (root: string) => `'${root.replaceAll("'", `'"'"'`)}'`;
    const block = (line: string) => `# >>> LANDO4 shellenv >>>\n${line}\n# <<< LANDO4 shellenv <<<\n`;
    const foreign = block(`export LANDO_USER_DATA_ROOT=${quote(foreignRoot)}`);
    const unknown = block(
      scenario === "missing" ? "export PATH='/bin'" : "export LANDO_USER_DATA_ROOT=$HOME/data",
    );
    const quotedRoot = join(roots.root, "data'quoted");
    const ownerRoot = scenario === "quoted" ? quotedRoot : roots.userDataRoot;
    const owned = block(`export LANDO_USER_DATA_ROOT=${quote(scenario === "canonical" ? alias : ownerRoot)}`);
    const original =
      scenario === "mixed"
        ? `${foreign}${owned}${foreign}`
        : scenario === "foreign"
          ? foreign
          : scenario === "missing" || scenario === "unparseable"
            ? unknown
            : owned;
    writeFileSync(roots.shellProfilePath, original);
    try {
      const result = await Effect.runPromise(
        uninstall(sandboxUninstallOptions(roots, { yes: true, purge: true, userDataRoot: ownerRoot })).pipe(
          Effect.provide(PrivateFileAccessService.layer),
        ),
      );
      const step = result.steps.find((entry) => entry.id === "shell-entries");
      const manual = scenario === "missing" || scenario === "unparseable";
      expect(step?.status).toBe(manual ? "manual" : scenario === "foreign" ? "user-owned" : "owned");
      expect(readFileSync(roots.shellProfilePath, "utf8")).toBe(
        scenario === "mixed" ? `${foreign}${foreign}` : manual || scenario === "foreign" ? original : "",
      );
      if (manual) expect(step?.detail).toContain("remove it by hand if it belongs to this install");
      if (scenario === "foreign" || scenario === "mixed") expect(step?.detail).toContain(foreignRoot);
    } finally {
      rmSync(roots.root, { recursive: true, force: true });
    }
  },
);
