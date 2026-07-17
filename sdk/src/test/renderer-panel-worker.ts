/// <reference lib="webworker" />

/**
 * Isolated panel worker for the §13.1 Renderer panel contract suite.
 * Only this worker imports the panel module; the host never does.
 */
import { pathToFileURL } from "node:url";

import { Schema } from "effect";

import { RendererPanelId } from "../schema/renderer-panel.ts";
import type { RendererPanel } from "../schema/renderer-panel.ts";

import {
  PANEL_OP,
  decodePanelContextPayload,
  decodePanelRequest,
  encodeFailureResponse,
  encodePanelView,
  encodeReadyResponse,
} from "./renderer-panel-protocol.ts";

declare const self: Worker;

const respond = (frame: Uint8Array): void => {
  const copy = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
  self.postMessage(copy, [copy]);
};

let panel: RendererPanel | undefined;

self.onmessage = async (event: MessageEvent<unknown>) => {
  try {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "type" in data &&
      (data as { type: string }).type === "init"
    ) {
      const init = data as { type: "init"; moduleUrl: string; manifestId: string };
      const mod = (await import(init.moduleUrl)) as { default?: RendererPanel };
      const candidate = mod.default;
      if (
        candidate === undefined ||
        typeof candidate !== "object" ||
        candidate === null ||
        typeof candidate.render !== "function" ||
        typeof candidate.id !== "string"
      ) {
        respond(encodeFailureResponse("Panel module default export is not a RendererPanel"));
        return;
      }
      const decodedId = Schema.decodeUnknownSync(RendererPanelId)(candidate.id);
      if (decodedId !== init.manifestId) {
        respond(
          encodeFailureResponse(
            `Panel id mismatch: module returned ${decodedId}, manifest expected ${init.manifestId}`,
          ),
        );
        return;
      }
      panel = candidate;
      respond(encodeReadyResponse(decodedId));
      return;
    }

    if (!(data instanceof ArrayBuffer) && !(ArrayBuffer.isView(data) && data instanceof Uint8Array)) {
      respond(encodeFailureResponse("Expected binary frame or init message"));
      return;
    }

    const frame =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const request = decodePanelRequest(frame);
    if (request.op !== PANEL_OP.render) {
      respond(encodeFailureResponse(`Unknown op ${request.op}`));
      return;
    }
    if (panel === undefined) {
      respond(encodeFailureResponse("Panel not ready"));
      return;
    }
    const ctx = decodePanelContextPayload(request.payload);
    const view = panel.render(ctx);
    const encoded = encodePanelView(view);
    const response = new Uint8Array(2 + encoded.byteLength);
    response[0] = 1;
    response[1] = PANEL_OP.render;
    response.set(encoded, 2);
    respond(response);
  } catch (cause) {
    respond(encodeFailureResponse(cause instanceof Error ? cause.message : String(cause)));
  }
};

// Keep the module URL helper import-stable for host construction of fixture URLs.
export const toModuleUrl = (absolutePath: string): string => pathToFileURL(absolutePath).href;
