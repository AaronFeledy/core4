/**
 * What the suite sends `pty-driver.ts` and what it reports back. Types only: the driver runs alone
 * in the test container, where type imports compile away.
 */
export type TerminalStep =
  /** Wait until `text` appears after everything earlier steps consumed. */
  | { readonly kind: "expect"; readonly text: string }
  /** Type `text` and Enter at once, answering one of Lando's own questions. */
  | { readonly kind: "answer"; readonly text: string }
  /** Wait until the terminal stops echoing (sudo is reading), then type `text` and Enter. */
  | { readonly kind: "password"; readonly text: string }
  /** Wait until the terminal stops echoing, then press Ctrl-C. */
  | { readonly kind: "interrupt" };

export type DriverScenario = {
  readonly id: string;
  /** Run as root by `bash -c` before the scenario: what an administrator set up beforehand. */
  readonly prepare?: string;
  /** Run as `bash -lc <script>` by `landotest`. */
  readonly script: string;
  /** `CAROOT` of the run; the driver reports whether its `rootCA.pem` reached the system bundle. */
  readonly caroot: string;
  /** Paths the transcript describes after the run, without following symlinks. */
  readonly observe: readonly string[];
} & ({ readonly io: "pty"; readonly steps: readonly TerminalStep[] } | { readonly io: "none" });

export interface DriverInput {
  /** The image's sudo password prompt, counted in every transcript. */
  readonly prompt: string;
  readonly scenarios: readonly DriverScenario[];
}

/**
 * One per completed step, in step order: the offset into `output` where an expected text started,
 * or the output length when a keystroke was sent.
 */
export interface StepMark {
  readonly kind: TerminalStep["kind"];
  readonly at: number;
  /** How many sudo invocations the run had made by then. */
  readonly sudoCalls: number;
}

export interface SystemTrust {
  /** Digests of the anchor directory listing and the system bundle, before and after the run. */
  readonly before: string;
  readonly after: string;
  /** Whether the system bundle holds the run's `rootCA.pem` afterwards. */
  readonly rootTrusted: boolean;
}

export interface PathFacts {
  readonly kind: "file" | "directory" | "symlink" | "other";
  readonly uid: number;
  readonly gid: number;
  /** Permission bits. */
  readonly mode: number;
  /** Where a symlink points. */
  readonly target?: string;
}

export type Transcript = {
  readonly id: string;
  /** The script's exit status; null when the driver had to kill it. */
  readonly exitCode: number | null;
  /** Occurrences of the sudo password prompt in everything the run printed. */
  readonly prompts: number;
  /** The arguments of every sudo invocation, in order. */
  readonly sudoCalls: readonly (readonly string[])[];
  readonly systemTrust: SystemTrust;
  /** Each observed path after `prepare`, or null when it does not exist. */
  readonly pathsBefore: Readonly<Record<string, PathFacts | null>>;
  /** Each observed path after the run. */
  readonly paths: Readonly<Record<string, PathFacts | null>>;
} & (
  | {
      readonly io: "pty";
      readonly output: string;
      readonly marks: readonly StepMark[];
      /** The step that never completed, when one stalled. */
      readonly stalled?: string;
    }
  | { readonly io: "none"; readonly stdout: string; readonly stderr: string }
);
