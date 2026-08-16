/** Types for the shared model scrambler. See the note in `scripts/scramble.mjs`. */

/** A 32-bit hash of the key and the file's own name. Never zero. */
export declare function seedFor(key: string, name: string): number;

/** XOR a buffer with the keystream for `name`, in place. Its own inverse. */
export declare function scramble(bytes: Uint8Array, key: string, name: string): Uint8Array;

/** The extension a scrambled model wears. */
export declare const PROTECTED_EXT: string;
