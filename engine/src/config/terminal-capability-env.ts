import { type HostEnv, copyPresentHostEnv } from "./host-env-copy.ts";

/**
 * Host vars used by Node hyperlink/color detectors (supports-hyperlinks,
 * supports-color) to decide OSC 8 / truecolor. Covers Ghostty, iTerm2,
 * WezTerm, VS Code, Windows Terminal, VTE, and Konsole. Do not grow this
 * list: interactive TTY capability detection is not a general fingerprint
 * passthrough, and must stay out of HOST_PROXY_ENV_NAMES.
 */
export const TERMINAL_CAPABILITY_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "VTE_VERSION",
  "WT_SESSION",
  "KONSOLE_VERSION",
];

export const resolveTerminalCapabilityEnv = (hostEnv: HostEnv): Record<string, string> =>
  copyPresentHostEnv(hostEnv, TERMINAL_CAPABILITY_ENV_ALLOWLIST);
