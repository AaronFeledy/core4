import type { OpenTuiModuleLike, RendererLike } from "./prompt-driver-types.ts";

export const installMonochromePromptAdapters = (mod: OpenTuiModuleLike, renderer: RendererLike): void => {
  const foreground = mod.RGBA.defaultForeground().buffer;
  const background = mod.RGBA.defaultBackground().buffer;
  // Native clear/box-fill cells otherwise retain RGB white, even with a default-intent theme.
  renderer.addPostProcessFn?.((buffer) => {
    const { fg, bg } = buffer.buffers;
    for (let offset = 0; offset < fg.length; offset += foreground.length) {
      fg.set(foreground, offset);
      bg.set(background, offset);
    }
  });
};

export const monochromePromptTerminal = (terminal: NodeJS.WriteStream): NodeJS.WriteStream => {
  let pending = "";
  const write = terminal.write.bind(terminal);
  let writeOverride: unknown;
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const cursorColorPrefix = `${esc}]12;`;
  const cursorColor = new RegExp(`${esc}\\]12;[^${bell}${esc}]*(?:${bell}|${esc}\\\\)`, "g");
  return new Proxy(terminal, {
    get(target, property) {
      if (property !== "write") {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      if (writeOverride !== undefined) return writeOverride;
      return (chunk: string | Uint8Array, ...args: readonly unknown[]) => {
        // Native cursor output ignores RGBA intent. Suppress only OSC 12, including split writes.
        const bytes = pending + Buffer.from(chunk).toString("latin1");
        const filtered = bytes.replace(cursorColor, "");
        const osc = filtered.lastIndexOf(cursorColorPrefix);
        const escapeIndex = osc === -1 ? filtered.lastIndexOf("\x1b") : osc;
        const suffix = escapeIndex === -1 ? "" : filtered.slice(escapeIndex);
        const incomplete =
          suffix !== "" && (cursorColorPrefix.startsWith(suffix) || suffix.startsWith(cursorColorPrefix));
        pending = incomplete ? suffix : "";
        const output = incomplete ? filtered.slice(0, escapeIndex) : filtered;
        return Reflect.apply(write, target, [Buffer.from(output, "latin1"), ...args]);
      };
    },
    set(target, property, value: unknown) {
      if (property === "write") {
        writeOverride = value;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
};
