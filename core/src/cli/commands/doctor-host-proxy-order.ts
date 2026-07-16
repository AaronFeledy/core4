export const compareCodePointStrings = (left: string, right: string): number => {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? -1);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? -1);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index] ?? -1;
    const rightCodePoint = rightCodePoints[index] ?? -1;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftCodePoints.length - rightCodePoints.length;
};
