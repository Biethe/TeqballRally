/** Types for the secret minting and hashing. See the note in `store.d.mts`. */
export declare const TOKEN_LENGTH: number;
export declare function mintToken(): string;
export declare function tokenHash(token: string): string;
export declare function mintRecovery(): {
  code: string;
  salt: string;
  hash: string;
  lookup: string;
};
/** The key a recovery code is found by, so the code alone finds its account. */
export declare function recoveryLookup(code: string): string;
export declare function tidyRecovery(raw: unknown): string;
export declare function recoveryHash(code: string, salt: string): string;
export declare function digestsMatch(a: unknown, b: unknown): boolean;
export declare function looksLikeRecovery(tidied: string): boolean;
