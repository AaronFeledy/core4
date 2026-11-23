/** Refuses preserved symlinks before a repo-root `bun` command or test run loads workspace code. */
import { preservedSymlinksMessage } from "../core/bin/preserve-symlinks.ts";

const message = preservedSymlinksMessage(process.env, process.execArgv);
if (message !== undefined) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
