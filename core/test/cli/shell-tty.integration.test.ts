import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.LANDO_TEST_SHELL_TTY === "1";
const repoRoot = resolve(import.meta.dirname, "../../..");
const landoBin = join(repoRoot, "core/bin/lando.ts");
const sessionName = `lando-shell-tty-${process.pid}`;
const hostCommandMarker = "LANDO_TTY_MARKER_shell-tty";
const longRunningMarker = "US439_LONG_RUNNING_STARTED";
const recoveredMarker = "US439_INTERRUPT_RECOVERED";
const pipedStdinMarker = "US439_PIPE_STDIN_OK";
const nonzeroMarker = "US439_NONZERO_COMPLETE";
const restoredMarker = "US439_TTY_RESTORED";

const tmux = (args: ReadonlyArray<string>): string => Bun.spawnSync(["tmux", ...args]).stdout.toString();

const capturePane = (): string => tmux(["capture-pane", "-t", sessionName, "-p"]);

const waitForPane = async (predicate: (pane: string) => boolean, timeoutMs = 20_000): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  do {
    pane = capturePane();
    if (predicate(pane)) return pane;
    await Bun.sleep(100);
  } while (Date.now() < deadline);

  return pane;
};

const waitForPaneText = async (text: string, timeoutMs = 20_000): Promise<void> => {
  const hasExactLine = (pane: string): boolean => pane.split("\n").some((line) => line.trim() === text);
  const pane = await waitForPane(hasExactLine, timeoutMs);
  expect(pane.split("\n").map((line) => line.trim())).toContain(text);
};

const waitForPaneLineSuffix = async (text: string): Promise<void> => {
  const hasSuffix = (pane: string): boolean => pane.split("\n").some((line) => line.trim().endsWith(text));
  const pane = await waitForPane(hasSuffix);
  expect(pane.split("\n").some((line) => line.trim().endsWith(text))).toBe(true);
};

describe("lando shell — interactive TTY (tmux)", () => {
  test.skipIf(!enabled)(
    "recovers from Ctrl+C, preserves the last status on EOF, and restores the terminal",
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

        tmux(["send-keys", "-t", sessionName, "echo LANDO_TTY_MARKER_$LANDO_APP_NAME", "Enter"]);
        await waitForPaneText(hostCommandMarker, 30_000);

        tmux(["send-keys", "-t", sessionName, `printf '${longRunningMarker}\\n'; sleep 30`, "Enter"]);
        await waitForPaneText(longRunningMarker);
        tmux(["send-keys", "-t", sessionName, "C-c"]);
        await waitForPaneText("lando>");

        tmux(["send-keys", "-t", sessionName, `echo ${recoveredMarker}`, "Enter"]);
        await waitForPaneText(recoveredMarker);

        tmux(["send-keys", "-t", sessionName, `printf '${pipedStdinMarker}\\n' | cat`, "Enter"]);
        await waitForPaneText(pipedStdinMarker);

        tmux([
          "send-keys",
          "-t",
          sessionName,
          `bun -e 'process.stdout.write("${nonzeroMarker}\\n"); process.exit(23)'`,
          "Enter",
        ]);
        await waitForPaneText(nonzeroMarker);
        tmux(["send-keys", "-t", sessionName, "C-d"]);
        await waitForPaneLineSuffix("LANDO_EXIT=23");

        tmux(["send-keys", "-t", sessionName, `echo ${restoredMarker}`, "Enter"]);
        await waitForPaneText(restoredMarker);
      } finally {
        tmux(["kill-session", "-t", sessionName]);
        await rm(app, { recursive: true, force: true });
      }
    },
    90000,
  );
});
