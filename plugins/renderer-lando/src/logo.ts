/** Terminal columns; rows are half the width for roughly square terminal artwork. */
export const LANDO_LOGO_WIDTHS = [8, 10, 12, 16, 20, 24, 32, 48, 64] as const;

const BRAILLE_DOTS = [
  [0, 0, 1],
  [0, 1, 2],
  [0, 2, 4],
  [1, 0, 8],
  [1, 1, 16],
  [1, 2, 32],
  [0, 3, 64],
  [1, 3, 128],
] as const;

/** Rasterize the planet, enclosing circle, and 20-degree rising orbit into 2x4-dot cells. */
export const renderLandoLogo = (width: (typeof LANDO_LOGO_WIDTHS)[number]) => {
  const height = width / 2;
  const radius = width - 0.65;
  const cosine = Math.cos(Math.PI / 9);
  const sine = Math.sin(Math.PI / 9);
  // Keep the approved small icons crisp; grow stroke weight with larger artwork.
  const outline = width <= 10 ? 0.48 : radius * 0.052;
  const orbit = width <= 10 ? 0.52 : radius * 0.056;
  const major = radius * 0.99;
  const minor = radius * 0.24;

  const hasInk = (x: number, y: number): boolean => {
    const distance = Math.hypot(x, y);
    const u = x * cosine - y * sine;
    const v = x * sine + y * cosine;
    const ellipse = Math.sqrt((u * u) / major ** 2 + (v * v) / minor ** 2);
    const gradient = Math.sqrt((u * u) / major ** 4 + (v * v) / minor ** 4) / (ellipse || 1);
    return (
      Math.abs(distance - radius) < outline ||
      distance < radius * 0.47 ||
      Math.abs(ellipse - 1) / (gradient || 1) < orbit
    );
  };

  const lines = Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (_, column) => {
      let mask = 0;
      for (const [dx, dy, bit] of BRAILLE_DOTS) {
        const x = column * 2 + dx - (width * 2 - 1) / 2;
        const y = row * 4 + dy - (height * 4 - 1) / 2;
        let coverage = 0;
        for (const ox of [-0.25, 0.25]) {
          for (const oy of [-0.25, 0.25]) coverage += Number(hasInk(x + ox, y + oy));
        }
        if (coverage >= 2) mask |= bit;
      }
      // U+2800 keeps blank cells explicit, including the right-hand padding.
      return String.fromCharCode(0x2800 + mask);
    }).join(""),
  );
  return { width, height, lines, content: lines.join("\n") } as const;
};

/** Largest complete icon that fits both dimensions; no icon below 8x4. */
export const pickLandoLogoWidth = (columns: number, rows: number) => {
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return undefined;
  return LANDO_LOGO_WIDTHS.findLast((width) => width <= columns && width / 2 <= rows);
};
