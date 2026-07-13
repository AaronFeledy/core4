import { REDACTED, type Redactor } from "@lando/sdk/secrets";

export interface StatefulShellRedactor<Channel extends string> {
  readonly push: (channel: Channel, chunk: string) => void;
  readonly flush: () => void;
  readonly captured: (channel: Channel) => string;
  readonly needsTrailingNewline: (channel: Channel) => boolean;
}

interface BufferedSegment<Channel extends string> {
  readonly channel: Channel;
  readonly text: string;
}

const MAX_CAPTURE_LENGTH = 65_536;

export const makeStatefulShellRedactor = <Channel extends string>(
  redactor: Redactor,
  values: ReadonlyArray<string>,
  write: (channel: Channel, chunk: string) => void,
): StatefulShellRedactor<Channel> => {
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  const maxPartialLength = Math.max(0, ...secrets.map((value) => value.length - 1));
  const buffered: BufferedSegment<Channel>[] = [];
  const captures = new Map<Channel, string>();
  const trailingNewline = new Map<Channel, boolean>();

  const emitPiece = (channel: Channel, text: string): void => {
    if (text.length === 0) return;
    const redacted = redactor.redactString(text);
    const captured = captures.get(channel) ?? "";
    captures.set(channel, captured + redacted.slice(0, MAX_CAPTURE_LENGTH - captured.length));
    trailingNewline.set(channel, redacted.endsWith("\n"));
    write(channel, redacted);
  };

  const channelAt = (index: number): Channel => {
    let offset = 0;
    for (const segment of buffered) {
      if (index < offset + segment.text.length) return segment.channel;
      offset += segment.text.length;
    }
    return (
      buffered[buffered.length - 1]?.channel ??
      (() => {
        throw new Error("Cannot resolve an output channel from an empty redaction buffer.");
      })()
    );
  };

  const emitRange = (start: number, end: number): void => {
    let offset = 0;
    for (const segment of buffered) {
      const segmentEnd = offset + segment.text.length;
      const from = Math.max(start, offset);
      const to = Math.min(end, segmentEnd);
      if (from < to) emitPiece(segment.channel, segment.text.slice(from - offset, to - offset));
      offset = segmentEnd;
      if (offset >= end) return;
    }
  };

  const consume = (length: number): void => {
    let remaining = length;
    while (remaining > 0) {
      const first = buffered.shift();
      if (first === undefined) return;
      if (first.text.length > remaining) {
        buffered.unshift({ channel: first.channel, text: first.text.slice(remaining) });
        return;
      }
      remaining -= first.text.length;
    }
  };

  const emit = (flush: boolean): void => {
    const text = buffered.map((segment) => segment.text).join("");
    let partialLength = 0;
    if (!flush) {
      const candidateLength = Math.min(text.length, maxPartialLength);
      for (let length = candidateLength; length > 0; length -= 1) {
        const suffix = text.slice(-length);
        if (secrets.some((secret) => secret.startsWith(suffix))) {
          partialLength = length;
          break;
        }
      }
    }
    const cutoff = text.length - partialLength;
    if (cutoff === 0) return;

    let cursor = 0;
    while (cursor < cutoff) {
      let matchIndex = -1;
      let match = "";
      for (const secret of secrets) {
        const index = text.indexOf(secret, cursor);
        if (
          index >= 0 &&
          (matchIndex < 0 || index < matchIndex || (index === matchIndex && secret.length > match.length))
        ) {
          matchIndex = index;
          match = secret;
        }
      }
      if (matchIndex < 0 || matchIndex >= cutoff) {
        emitRange(cursor, cutoff);
        cursor = cutoff;
      } else {
        emitRange(cursor, matchIndex);
        emitPiece(channelAt(matchIndex), REDACTED);
        cursor = matchIndex + match.length;
      }
    }
    consume(cursor);
  };

  return {
    push: (channel, chunk) => {
      if (chunk.length > 0) buffered.push({ channel, text: chunk });
      emit(false);
    },
    flush: () => emit(true),
    captured: (channel) => captures.get(channel) ?? "",
    needsTrailingNewline: (channel) => trailingNewline.get(channel) === false,
  };
};
