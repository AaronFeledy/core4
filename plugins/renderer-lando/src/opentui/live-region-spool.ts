import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LiveRegionSpool {
  append(line: string): void;
  readLines(): Promise<ReadonlyArray<string>>;
  remove(): Promise<void>;
}

export type LiveRegionSpoolFactory = () => LiveRegionSpool;

const MAX_DEFERRED_SCROLLBACK_CHARACTERS = 256 * 1024;

export class DeferredScrollback {
  private lines: string[] = [];
  private characters = 0;
  private spool: LiveRegionSpool | undefined;

  constructor(private readonly spoolFactory: LiveRegionSpoolFactory) {}

  push(line: string): void {
    this.lines.push(line);
    this.characters += line.length;
    if (this.spool === undefined && this.characters > MAX_DEFERRED_SCROLLBACK_CHARACTERS) {
      this.spool = this.spoolFactory();
      for (const deferred of this.lines) this.spool.append(deferred);
    } else {
      this.spool?.append(line);
    }
    while (this.characters > MAX_DEFERRED_SCROLLBACK_CHARACTERS && this.lines.length > 0) {
      const removed = this.lines.shift();
      if (removed !== undefined) this.characters -= removed.length;
    }
  }

  /**
   * Commits every deferred row in arrival order, then calls `release` in the
   * same tick that finds the buffer empty, so the caller can stop deferring
   * with no window where a pushed row is neither committed nor deferred. Each
   * pass detaches the current rows first; rows pushed during a spool read land
   * in a fresh buffer that the next pass commits after them. On failure the
   * remaining rows are dropped and `release` still runs before the error.
   */
  async flush(commit: (row: string) => void, release: () => void): Promise<void> {
    try {
      while (this.lines.length > 0 || this.spool !== undefined) {
        const { lines, spool } = this.detach();
        if (spool === undefined) {
          for (const line of lines) commit(line);
          continue;
        }
        try {
          for (const line of await spool.readLines()) commit(line);
        } finally {
          await spool.remove();
        }
      }
    } catch (cause) {
      const { spool } = this.detach();
      release();
      await spool?.remove();
      throw cause;
    }
    release();
  }

  async clear(): Promise<void> {
    await this.detach().spool?.remove();
  }

  private detach(): { readonly lines: ReadonlyArray<string>; readonly spool: LiveRegionSpool | undefined } {
    const detached = { lines: this.lines, spool: this.spool };
    this.lines = [];
    this.characters = 0;
    this.spool = undefined;
    return detached;
  }
}

class FileLiveRegionSpool implements LiveRegionSpool {
  private directory: string | undefined;
  private path: string | undefined;
  private operations: Promise<void> = Promise.resolve();

  append(line: string): void {
    this.operations = this.operations.then(async () => {
      const path = await this.ensureFile();
      await appendFile(path, `${JSON.stringify(line)}\n`, { encoding: "utf8" });
    });
  }

  async readLines(): Promise<ReadonlyArray<string>> {
    await this.operations;
    const path = this.path;
    if (path === undefined) return [];
    const contents = await readFile(path, "utf8");
    const lines: string[] = [];
    for (const encoded of contents.split("\n")) {
      if (encoded.length === 0) continue;
      const decoded: unknown = JSON.parse(encoded);
      if (typeof decoded !== "string") throw new TypeError("Invalid deferred scrollback spool entry.");
      lines.push(decoded);
    }
    return lines;
  }

  async remove(): Promise<void> {
    await this.operations.catch(() => undefined);
    const directory = this.directory;
    this.directory = undefined;
    this.path = undefined;
    if (directory === undefined) return;
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
  }

  private async ensureFile(): Promise<string> {
    if (this.path !== undefined) return this.path;
    const directory = await mkdtemp(join(tmpdir(), "lando-live-region-"));
    const path = join(directory, "scrollback.ndjson");
    this.directory = directory;
    await writeFile(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    this.path = path;
    return path;
  }
}

export const createLiveRegionSpool: LiveRegionSpoolFactory = () => new FileLiveRegionSpool();
