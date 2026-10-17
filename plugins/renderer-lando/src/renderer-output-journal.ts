import type { RendererNarrationIO } from "@lando/sdk/renderer";

interface LiveRegionOutput {
  readonly commitScrollback: (text: string) => void;
  readonly rememberScrollback: (text: string) => void;
  readonly noteInPlaceOutput?: () => void;
  readonly suspendOutput?: (text: string, write: () => void) => void;
}

const MAX_RETAINED_CHARACTERS = 256 * 1024;

class RendererOutputJournal {
  readonly #io: RendererNarrationIO;
  #active: LiveRegionOutput | undefined;
  #retained: string[] = [];
  #retainedCharacters = 0;

  constructor(io: RendererNarrationIO) {
    this.#io = io;
  }

  writeOutput(text: string, write: () => void, terminal: boolean): void {
    if (terminal && this.#active?.suspendOutput !== undefined) {
      this.#active.suspendOutput(text, write);
      return;
    }
    write();
  }

  writeStderr(text: string): void {
    if (this.#active !== undefined) {
      this.#active.commitScrollback(text);
      return;
    }
    this.#remember(text);
    this.#io.writeStderr(text);
  }

  attach(output: LiveRegionOutput): void {
    for (const text of this.#retained) output.rememberScrollback(text);
    this.#retained = [];
    this.#retainedCharacters = 0;
    this.#active = output;
  }

  detach(output: LiveRegionOutput): void {
    if (this.#active === output) this.#active = undefined;
  }

  #remember(text: string): void {
    if (text.length === 0) return;
    this.#retained.push(text);
    this.#retainedCharacters += text.length;
    while (this.#retainedCharacters > MAX_RETAINED_CHARACTERS && this.#retained.length > 0) {
      const removed = this.#retained.shift();
      if (removed !== undefined) this.#retainedCharacters -= removed.length;
    }
  }
}

const journals = new WeakMap<RendererNarrationIO, RendererOutputJournal>();

export const outputJournalFor = (io: RendererNarrationIO): RendererOutputJournal => {
  const existing = journals.get(io);
  if (existing !== undefined) return existing;
  const journal = new RendererOutputJournal(io);
  journals.set(io, journal);
  return journal;
};
