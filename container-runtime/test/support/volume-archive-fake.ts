import { tarPayloadMember } from "@lando/sdk/test";

import { classifyVolumeArchiveCommand } from "../../src/volume-archive.ts";

/**
 * In-memory model of the data-plane volume archive helpers for provider contract
 * fakes. File bytes (the cat probe) stay separate from archive bytes so a fake can
 * prove staging: an extract never changes a live volume until publish runs.
 */
export interface VolumeArchiveSnapshot {
  readonly files: Uint8Array;
  readonly archives: Uint8Array;
}

interface StagedVolume {
  readonly archive?: Uint8Array;
  readonly files?: Uint8Array;
}

export interface VolumeArchiveFakeState {
  readonly files: Map<string, Uint8Array>;
  readonly archives: Map<string, Uint8Array>;
  readonly staged: Map<string, StagedVolume>;
  readonly snapshots: Map<string, VolumeArchiveSnapshot>;
}

export const makeVolumeArchiveFakeState = (
  files: Map<string, Uint8Array> = new Map(),
  snapshots: Map<string, VolumeArchiveSnapshot> = new Map(),
): VolumeArchiveFakeState => ({ files, archives: new Map(), staged: new Map(), snapshots });

const volumeArchiveFakeStagedKey = (volume: string, id: string): string => `${volume}/${id}`;

/** True when this helper reads an archive from stdin and therefore gates the container's exit. */
export const volumeArchiveFakeReadsStdin = (command: ReadonlyArray<string>): boolean =>
  classifyVolumeArchiveCommand(command).kind === "extract";

/**
 * Interpret a helper argv at container start. Returns the bytes the fake should
 * expose on stdout, or undefined when the command is not a volume archive helper.
 */
export const volumeArchiveFakeStart = (input: {
  readonly state: VolumeArchiveFakeState;
  readonly command: ReadonlyArray<string>;
  readonly volume: string | undefined;
  readonly image: string | undefined;
}): Uint8Array | undefined => {
  const call = classifyVolumeArchiveCommand(input.command);
  if (call.kind === "unknown" || input.volume === undefined) return undefined;
  switch (call.kind) {
    case "export":
      return input.state.archives.get(input.volume) ?? new Uint8Array();
    case "snapshot-capture":
      return new Uint8Array();
    case "extract":
      // The archive arrives on stdin; attach records it under the same id.
      return new Uint8Array();
    case "snapshot-extract": {
      const snapshot = input.image === undefined ? undefined : input.state.snapshots.get(input.image);
      input.state.staged.set(volumeArchiveFakeStagedKey(input.volume, call.id), {
        ...(snapshot === undefined ? {} : { archive: snapshot.archives, files: snapshot.files }),
      });
      return new Uint8Array();
    }
    case "publish": {
      const key = volumeArchiveFakeStagedKey(input.volume, call.id);
      const staged = input.state.staged.get(key);
      if (staged !== undefined) {
        if (staged.archive !== undefined)
          input.state.archives.set(input.volume, new Uint8Array(staged.archive));
        if (staged.files !== undefined) input.state.files.set(input.volume, new Uint8Array(staged.files));
        input.state.staged.delete(key);
      }
      return new Uint8Array();
    }
    case "dispose":
    case "discard":
      input.state.staged.delete(volumeArchiveFakeStagedKey(input.volume, call.id));
      return new Uint8Array();
  }
};

/** Record an extract helper's stdin. Publish is what makes it visible to the volume. */
export const volumeArchiveFakeStdin = (input: {
  readonly state: VolumeArchiveFakeState;
  readonly command: ReadonlyArray<string>;
  readonly volume: string;
  readonly bytes: Uint8Array;
}): void => {
  const call = classifyVolumeArchiveCommand(input.command);
  if (call.kind !== "extract") return;
  const fileBytes = tarPayloadMember(input.bytes);
  input.state.staged.set(volumeArchiveFakeStagedKey(input.volume, call.id), {
    archive: new Uint8Array(input.bytes),
    ...(fileBytes === undefined ? {} : { files: new Uint8Array(fileBytes) }),
  });
};
