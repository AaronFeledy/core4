/**
 * Shared guide-variant string protocol (`axis=value axis2=value2`).
 * Zero-import leaf so docs config-time loaders can depend on it without Effect.
 */

export const encodeVariantPair = (axis: string, value: string): string => `${axis}=${value}`;

export const encodeVariantString = (pairs: readonly string[]): string => pairs.join(" ");

/**
 * File-name suffix for a variant string: empty for no variant, else
 * `.axis1=value1.axis2=value2...` retaining each pair so distinct axes with the
 * same value cannot collide (injective over well-formed pair sequences).
 * Malformed pairs without `=` contribute an empty segment (same slot count as input).
 */
export const variantFileSuffix = (variant: string): string =>
  variant === ""
    ? ""
    : `.${variant
        .split(" ")
        .map((pair) => {
          const separator = pair.indexOf("=");
          if (separator <= 0) return "";
          return pair;
        })
        .join(".")}`;
