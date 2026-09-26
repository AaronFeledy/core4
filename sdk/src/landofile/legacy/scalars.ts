export const resolvePlainScalar = (text: string): string | number | boolean | null => {
  // Full-string matching must not accept a trailing newline via JavaScript's `$`.
  if (text.trim() !== text) return text;
  if (/^(?:|~|null|Null|NULL)$/.test(text)) return null;
  if (/^(?:true|True|TRUE)$/.test(text)) return true;
  if (/^(?:false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text))
    return text.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return Number.NaN;
  if (/^(?:0x[0-9a-fA-F]+|0o[0-7]+|0b[01]+)$/.test(text)) return Number(text);
  // Bare leading-zero decimals stay strings even though the float grammar overlaps.
  if (/^[-+]?0[0-9]+$/.test(text)) return text;
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) {
    return Number(text);
  }
  return text;
};
