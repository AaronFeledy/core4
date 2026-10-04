/** Host-side terminal QR rendering for CLI text output. */
import { renderUnicodeCompact } from "uqr";

const LOCAL_QR_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LNDO_SITE_SUFFIX = ".lndo.site";
const ENVELOPE_FORMATS = new Set(["json", "yaml"]);

export interface TerminalQrDecision {
  readonly url: string | undefined;
  readonly isTTY: boolean;
  readonly format?: string;
  readonly force?: boolean;
}

export const isLocalQrUrl = (value: string): boolean => {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return LOCAL_QR_HOSTS.has(hostname) || hostname.endsWith(LNDO_SITE_SUFFIX);
  } catch {
    return false;
  }
};

export const shouldRenderTerminalQr = (decision: TerminalQrDecision): boolean => {
  if (decision.url === undefined || decision.url.length === 0) return false;
  if (decision.format !== undefined && ENVELOPE_FORMATS.has(decision.format)) return false;
  if (!decision.isTTY) return false;
  if (decision.force === true) return true;
  return !isLocalQrUrl(decision.url);
};

export const renderTerminalQr = (value: string): string | undefined => {
  try {
    const qr = renderUnicodeCompact(value);
    return qr.endsWith("\n") ? qr : `${qr}\n`;
  } catch {
    return undefined;
  }
};

export const appendTerminalQr = (text: string, decision: TerminalQrDecision): string => {
  if (!shouldRenderTerminalQr(decision) || decision.url === undefined) return text;
  const qr = renderTerminalQr(decision.url);
  if (qr === undefined) return text;
  return text.endsWith("\n") ? `${text}${qr}` : `${text}\n${qr}`;
};
