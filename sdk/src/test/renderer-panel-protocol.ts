import { Schema } from "effect";

import {
  PanelView,
  type PanelView as PanelViewType,
  RendererPanelContext,
  type RendererPanelContext as RendererPanelContextType,
  RendererPanelId,
  type StyledSpan,
  type StyledSpanTone,
} from "../schema/renderer-panel.ts";

/** Protocol version byte for host↔worker panel frames. */
export const PANEL_PROTOCOL_VERSION = 1;

/** Operation codes on the binary channel. */
export const PANEL_OP = {
  init: 0,
  ready: 1,
  render: 2,
  failure: 3,
} as const;

export const PANEL_REQUEST_MAX_BYTES = 65_542;
export const PANEL_PAYLOAD_MAX_BYTES = 65_536;
export const PANEL_RESPONSE_MAX_BYTES = 5_129;
export const PANEL_READY_DEADLINE_MS = 1_000;
export const PANEL_RENDER_DEADLINE_MS = 8;

const TONE_TO_BYTE: Record<StyledSpanTone, number> = {
  default: 0,
  muted: 1,
  accent: 2,
  success: 3,
  warning: 4,
  danger: 5,
};

const BYTE_TO_TONE: ReadonlyArray<StyledSpanTone> = [
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
];

const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const writeU32BE = (view: DataView, offset: number, value: number): void => {
  view.setUint32(offset, value, false);
};

const readU32BE = (view: DataView, offset: number): number => view.getUint32(offset, false);

const writeU16BE = (view: DataView, offset: number, value: number): void => {
  view.setUint16(offset, value, false);
};

const readU16BE = (view: DataView, offset: number): number => view.getUint16(offset, false);

/**
 * Encode a host→worker request frame: version | op | payloadLen(u32 BE) | payload.
 */
export const encodePanelRequest = (op: number, payload: Uint8Array): Uint8Array => {
  if (payload.byteLength > PANEL_PAYLOAD_MAX_BYTES) {
    throw new Error(`Panel request payload exceeds ${PANEL_PAYLOAD_MAX_BYTES} bytes`);
  }
  const total = 6 + payload.byteLength;
  if (total > PANEL_REQUEST_MAX_BYTES) {
    throw new Error(`Panel request exceeds ${PANEL_REQUEST_MAX_BYTES} bytes`);
  }
  const frame = new Uint8Array(total);
  frame[0] = PANEL_PROTOCOL_VERSION;
  frame[1] = op;
  writeU32BE(new DataView(frame.buffer), 2, payload.byteLength);
  frame.set(payload, 6);
  return frame;
};

export const decodePanelRequest = (
  frame: Uint8Array,
): { readonly version: number; readonly op: number; readonly payload: Uint8Array } => {
  if (frame.byteLength < 6) throw new Error("Panel request frame too short");
  if (frame.byteLength > PANEL_REQUEST_MAX_BYTES) throw new Error("Panel request frame too large");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = frame[0] ?? 0;
  const op = frame[1] ?? 0;
  const length = readU32BE(view, 2);
  if (length > PANEL_PAYLOAD_MAX_BYTES) throw new Error("Panel request payload length over limit");
  if (6 + length > frame.byteLength) throw new Error("Panel request payload truncated");
  return { version, op, payload: frame.subarray(6, 6 + length) };
};

export const encodePanelContextPayload = (ctx: RendererPanelContextType | unknown): Uint8Array => {
  // Accept decoded Type or wire/unknown form so fixtures can pass plain JSON-shaped contexts.
  const decoded = Schema.decodeUnknownSync(RendererPanelContext)(ctx);
  const encoded = Schema.encodeSync(RendererPanelContext)(decoded);
  return encodeUtf8(JSON.stringify(encoded));
};

/** Binary init payload: u16 BE manifestIdLen | manifestId | u16 BE moduleUrlLen | moduleUrl. */
export const encodePanelInitPayload = (manifestId: string, moduleUrl: string): Uint8Array => {
  const idBytes = encodeUtf8(manifestId);
  const urlBytes = encodeUtf8(moduleUrl);
  if (idBytes.byteLength > 0xffff || urlBytes.byteLength > 0xffff) {
    throw new Error("Panel init string exceeds u16 length");
  }
  const out = new Uint8Array(4 + idBytes.byteLength + urlBytes.byteLength);
  const view = new DataView(out.buffer);
  writeU16BE(view, 0, idBytes.byteLength);
  out.set(idBytes, 2);
  writeU16BE(view, 2 + idBytes.byteLength, urlBytes.byteLength);
  out.set(urlBytes, 4 + idBytes.byteLength);
  return out;
};

export const decodePanelInitPayload = (
  payload: Uint8Array,
): { readonly manifestId: string; readonly moduleUrl: string } => {
  if (payload.byteLength < 4) throw new Error("Panel init payload too short");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const idLen = readU16BE(view, 0);
  if (2 + idLen + 2 > payload.byteLength) throw new Error("Panel init payload truncated (id)");
  const manifestId = decodeUtf8(payload.subarray(2, 2 + idLen));
  const urlLen = readU16BE(view, 2 + idLen);
  const urlStart = 4 + idLen;
  if (urlStart + urlLen > payload.byteLength) throw new Error("Panel init payload truncated (url)");
  const moduleUrl = decodeUtf8(payload.subarray(urlStart, urlStart + urlLen));
  return { manifestId, moduleUrl };
};

export const decodePanelContextPayload = (payload: Uint8Array): RendererPanelContextType => {
  const json = JSON.parse(decodeUtf8(payload)) as unknown;
  return Schema.decodeUnknownSync(RendererPanelContext)(json);
};

/**
 * Bounded binary PanelView encoding (max 5,129 bytes).
 */
export const encodePanelView = (view: PanelViewType): Uint8Array => {
  const rows = view;
  if (rows.length > 8) throw new Error("PanelView row count exceeds 8");
  let totalText = 0;
  const chunks: Uint8Array[] = [new Uint8Array([rows.length])];
  for (const row of rows) {
    if (row.length > 32) throw new Error("PanelView span count exceeds 32");
    chunks.push(new Uint8Array([row.length]));
    for (const span of row) {
      const textBytes = encodeUtf8(span.text);
      totalText += textBytes.byteLength;
      if (totalText > 4096) throw new Error("PanelView text exceeds 4096 bytes");
      const tone = TONE_TO_BYTE[span.tone ?? "default"] ?? 0;
      let flags = 0;
      if (span.bold) flags |= 1;
      if (span.dim) flags |= 2;
      if (span.italic) flags |= 4;
      if (span.underline) flags |= 8;
      const header = new Uint8Array(4);
      header[0] = tone;
      header[1] = flags;
      writeU16BE(new DataView(header.buffer), 2, textBytes.byteLength);
      chunks.push(header, textBytes);
    }
  }
  let size = 0;
  for (const c of chunks) size += c.byteLength;
  if (size > PANEL_RESPONSE_MAX_BYTES) throw new Error("PanelView encoding exceeds response ceiling");
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};

export const decodePanelView = (bytes: Uint8Array): PanelViewType => {
  if (bytes.byteLength > PANEL_RESPONSE_MAX_BYTES) throw new Error("Panel response exceeds 5129 bytes");
  if (bytes.byteLength < 1) throw new Error("Panel response empty");
  let offset = 0;
  const rowCount = bytes[offset++] ?? 0;
  if (rowCount > 8) throw new Error("PanelView row count exceeds 8");
  const rows: StyledSpan[][] = [];
  for (let r = 0; r < rowCount; r++) {
    if (offset >= bytes.byteLength) throw new Error("Panel response truncated (row header)");
    const spanCount = bytes[offset++] ?? 0;
    if (spanCount > 32) throw new Error("PanelView span count exceeds 32");
    const spans: StyledSpan[] = [];
    for (let s = 0; s < spanCount; s++) {
      if (offset + 4 > bytes.byteLength) throw new Error("Panel response truncated (span header)");
      const toneByte = bytes[offset++] ?? 0;
      const flags = bytes[offset++] ?? 0;
      const textLen = readU16BE(new DataView(bytes.buffer, bytes.byteOffset + offset, 2), 0);
      offset += 2;
      if (offset + textLen > bytes.byteLength) throw new Error("Panel response truncated (span text)");
      const text = decodeUtf8(bytes.subarray(offset, offset + textLen));
      offset += textLen;
      const tone = BYTE_TO_TONE[toneByte] ?? "default";
      spans.push({
        text,
        tone,
        bold: (flags & 1) !== 0,
        dim: (flags & 2) !== 0,
        italic: (flags & 4) !== 0,
        underline: (flags & 8) !== 0,
      });
    }
    rows.push(spans);
  }
  return Schema.decodeUnknownSync(PanelView)(rows);
};

export const encodeReadyResponse = (id: string): Uint8Array => {
  const idBytes = encodeUtf8(id);
  const frame = new Uint8Array(2 + idBytes.byteLength);
  frame[0] = PANEL_PROTOCOL_VERSION;
  frame[1] = PANEL_OP.ready;
  frame.set(idBytes, 2);
  return frame;
};

export const decodeReadyResponse = (frame: Uint8Array): string => {
  if (frame.byteLength < 2) throw new Error("Ready frame too short");
  if ((frame[1] ?? 0) !== PANEL_OP.ready) throw new Error("Not a ready frame");
  const id = decodeUtf8(frame.subarray(2));
  return Schema.decodeUnknownSync(RendererPanelId)(id);
};

export const encodeFailureResponse = (message: string): Uint8Array => {
  const msg = encodeUtf8(message);
  const frame = new Uint8Array(2 + msg.byteLength);
  frame[0] = PANEL_PROTOCOL_VERSION;
  frame[1] = PANEL_OP.failure;
  frame.set(msg, 2);
  return frame;
};
