/** Types for the presence map. See the note in `store.d.mts`. */
export declare function arrived(id: string | null | undefined): void;
export declare function left(id: string | null | undefined): void;
export declare function isOnline(id: string): boolean;
export declare function onlineCount(): number;
/** Forget everyone. Only for tests; a running server has sockets to trust. */
export declare function reset(): void;
