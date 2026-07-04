import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.LANDO_TEST_SHELL_TTY === "1";
const repoRoot = resolve(import.meta.dirname, "../../..");
const landoBin = join(repoRoot, "core/bin/lando.ts");
const sessionName = `lando-shell-tty-${process.pid}`;

const tmux = (args: ReadonlyArray<string>): string => Bun.spawnSync(["tmux", ...args]).stdout.toString();

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("lando shell — interactive TTY (tmux)", () => {
  test.skipIf(!enabled)(
    "opens an interactive host shell, propagates the exit code, and restores the terminal",
    async () => {
      const app = await mkdtemp(join(tmpdir(), "lando-shell-tty-"));
      try {
        await writeFile(
          join(app, ".lando.yml"),
          "name: shell-tty\nservices:\n  web:\n    type: node:22\n    primary: true\n",
        );
        tmux(["kill-session", "-t", sessionName]);
        tmux(["new-session", "-d", "-s", sessionName, "-x", "200", "-y", "50"]);
        tmux([
          "send-keys",
          "-t",
          sessionName,
          `cd ${app} && SHELL=/bin/bash HOME=${app} bun ${landoBin} shell; echo LANDO_EXIT=$?`,
          "Enter",
        ]);
        await sleep(15000);

        tmux(["send-keys", "-t", sessionName, "echo LANDO_TTY_MARKER_$LANDO_APP_NAME", "Enter"]);
        await sleep(3000);
        expect(tmux(["capture-pane", "-t", sessionName, "-p"])).toContain("LANDO_TTY_MARKER_shell-tty");

        tmux(["send-keys", "-t", sessionName, "exit 7", "Enter"]);
        await sleep(3000);
        expect(tmux(["capture-pane", "-t", sessionName, "-p"])).toContain("LANDO_EXIT=7");

        tmux(["send-keys", "-t", sessionName, "echo TTY_RESTORED", "Enter"]);
        await sleep(1500);
        expect(tmux(["capture-pane", "-t", sessionName, "-p"])).toContain("TTY_RESTORED");
      } finally {
        tmux(["kill-session", "-t", sessionName]);
        await rm(app, { recursive: true, force: true });
      }
    },
    60000,
  );
});
