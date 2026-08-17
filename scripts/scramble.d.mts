/** Types for the shared asset encryption. See the note in `scripts/scramble.mjs`. */

/** The extension an encrypted asset wears. */
export declare const PROTECTED_EXT: string;
/** Bytes of IV on the front, and authentication tag on the end. */
export declare const IV_BYTES: number;
export declare const TAG_BYTES: number;

/** Which files the build encrypts and the game must decrypt, by extension. */
export declare const PROTECTED_EXTENSIONS: readonly string[];
/** Directories under `dist/` whose contents are encrypted. */
export declare const PROTECTED_DIRS: readonly string[];
/** Where raw art lives, deliberately outside Vite's `publicDir`. */
export declare const ART_SOURCE_DIR: string;

/** Whether this path is one the build encrypts and the game must decrypt. */
export declare function isProtectedAsset(path: string): boolean;

/** A 256-bit key from a passphrase of any length. */
export declare function keyFrom(passphrase: string): Uint8Array;

/** Encrypt one asset with AES-256-GCM. Returns `[IV][ciphertext][tag]`. */
export declare function encryptAsset(bytes: Uint8Array, passphrase: string): Uint8Array;

/** Decrypt one asset. Throws if the file has been altered. */
export declare function decryptAsset(bytes: Uint8Array, passphrase: string): Uint8Array;
