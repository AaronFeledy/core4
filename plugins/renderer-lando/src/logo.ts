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

// A 4x4 area sample avoids the narrow caps that a 2x2 half-coverage tie
// adds to small planets. Use the same sampling grid at every icon size.
const SAMPLE_OFFSETS = [-0.375, -0.125, 0.125, 0.375] as const;

// Geometry measured from the original 282x282 Lando mark, centered at (141, 141).
// The orbit is a crescent: an offset cutout gives it tapered tips and a broad
// lower edge. A uniformly stroked ellipse loses that defining shape.
const ORBIT_COSINE = Math.cos((16.4 * Math.PI) / 180);
const ORBIT_SINE = Math.sin((16.4 * Math.PI) / 180);

const insideEllipse = (x: number, y: number, major: number, minor: number): boolean => {
  const u = x * ORBIT_COSINE - y * ORBIT_SINE;
  const v = x * ORBIT_SINE + y * ORBIT_COSINE;
  return (u / major) ** 2 + (v / minor) ** 2 < 1;
};

const hasInk = (x: number, y: number, planetRadius: number): boolean => {
  const distanceSquared = x * x + y * y;
  if (distanceSquared > 141 ** 2) return false;
  return (
    distanceSquared >= 123 ** 2 ||
    distanceSquared < planetRadius ** 2 ||
    (insideEllipse(x + 0.4, y + 0.6, 126.7, 34.3) && !insideEllipse(x + 3.95, y + 12.1, 91.05, 23.75))
  );
};

/** Rasterize the original mark's planet, enclosing circle, and tapered orbit into 2x4-dot cells. */
export const renderLandoLogo = (width: (typeof LANDO_LOGO_WIDTHS)[number]) => {
  const height = width / 2;
  const scale = 141 / width;
  // At small sizes, pull the planet edge inward by up to one third of a dot
  // to avoid two-dot caps. The optical correction tapers to zero at 16 columns.
  const planetRadius = 65 - Math.max(0, (16 - width) / 24) * scale;

  const lines = Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (_, column) => {
      let mask = 0;
      for (const [dx, dy, bit] of BRAILLE_DOTS) {
        const x = column * 2 + dx - (width * 2 - 1) / 2;
        const y = row * 4 + dy - (height * 4 - 1) / 2;
        let coverage = 0;
        for (const ox of SAMPLE_OFFSETS) {
          for (const oy of SAMPLE_OFFSETS) {
            coverage += Number(hasInk((x + ox) * scale, (y + oy) * scale, planetRadius));
          }
        }
        if (coverage >= 8) mask |= bit;
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
