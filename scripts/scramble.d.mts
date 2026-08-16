/** Types for the shared model encryption. See the note in `scripts/scramble.mjs`. */

/** The extension an encrypted model wears. */
export declare const PROTECTED_EXT: string;
/** Bytes of IV on the front, and authentication tag on the end. */
export declare const IV_BYTES: number;
export declare const TAG_BYTES: number;

/** A 256-bit key from a passphrase of any length. */
export declare function keyFrom(passphrase: string): Uint8Array;

/** Encrypt one model with AES-256-GCM. Returns `[IV][ciphertext][tag]`. */
export declare function encryptModel(bytes: Uint8Array, passphrase: string): Uint8Array;

/** Decrypt one model. Throws if the file has been altered. */
export declare function decryptModel(bytes: Uint8Array, passphrase: string): Uint8Array;
