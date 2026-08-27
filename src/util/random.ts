import { randomInt } from "node:crypto";

const AFFINE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/** Generate an unbiased cryptographically secure string from a unique alphabet. */
export function secureRandomString(length: number, alphabet: string): string {
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error("Random string length must be a positive safe integer.");
  }
  if (alphabet.length < 2) {
    throw new Error("Random string alphabet must contain at least two characters.");
  }
  if (new Set(alphabet).size !== alphabet.length) {
    throw new Error("Random string alphabet must not contain duplicate characters.");
  }

  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += alphabet[randomInt(alphabet.length)]!;
  }
  return result;
}

/** Generate the 10-character identifier used by AFFiNE documents, blocks, and elements. */
export function secureAffineId(): string {
  return secureRandomString(10, AFFINE_ID_ALPHABET);
}

/** Generate the non-negative signed 32-bit seed expected by AFFiNE surface elements. */
export function secureRandomInt31(): number {
  return randomInt(0, 2 ** 31);
}
