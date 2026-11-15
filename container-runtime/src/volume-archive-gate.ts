import { VolumeArchiveWalker } from "./volume-archive-walker.ts";

/** Second end-of-archive block, synthesized so no unvalidated source byte reaches tar. */
const terminatingBlock = new Uint8Array(512);

/**
 * Holds back every byte of a member until the walker validated the member's header and
 * extended-header records. Forwarded bytes always form a validated prefix of the archive.
 * Once the walker sees the first end block, the gate appends a synthetic zero block and drops
 * every later source byte, so nothing after the end marker reaches tar unvalidated and a long
 * trailing suffix cannot grow memory while the source is still consumed.
 */
export class VolumeArchiveGate {
  readonly #walker: VolumeArchiveWalker;
  #held = new Uint8Array();
  #emitted = 0;
  #finished = false;

  constructor(path: string) {
    this.#walker = new VolumeArchiveWalker(path);
  }

  /** Bytes currently held back from the extractor; bounded after the end blocks. */
  get bufferedBytes(): number {
    return this.#held.byteLength;
  }

  push(chunk: Uint8Array): Uint8Array {
    if (chunk.byteLength === 0 || this.#finished) return new Uint8Array();
    const combined = new Uint8Array(this.#held.byteLength + chunk.byteLength);
    combined.set(this.#held);
    combined.set(chunk, this.#held.byteLength);
    this.#held = combined;
    this.#walker.push(chunk);
    if (!this.#walker.done) return this.#release(this.#walker.validatedBytes);
    const validated = this.#walker.validatedBytes;
    // The end marker completes the archive, so its completeness checks run now.
    this.#walker.finish();
    const released = this.#release(validated);
    this.#held = new Uint8Array();
    this.#finished = true;
    const output = new Uint8Array(released.byteLength + terminatingBlock.byteLength);
    output.set(released);
    output.set(terminatingBlock, released.byteLength);
    return output;
  }

  finish(): Uint8Array {
    if (this.#finished) return new Uint8Array();
    this.#walker.finish();
    this.#finished = true;
    return this.#release(this.#walker.validatedBytes);
  }

  #release(limit: number): Uint8Array {
    const emit = Math.min(limit - this.#emitted, this.#held.byteLength);
    if (emit <= 0) return new Uint8Array();
    const output = this.#held.slice(0, emit);
    this.#held = this.#held.subarray(emit);
    this.#emitted += emit;
    return output;
  }
}
