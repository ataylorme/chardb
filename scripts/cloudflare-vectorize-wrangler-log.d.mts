export function removeTemporaryWranglerLog(file: string): Promise<void>;
export function withTemporaryWranglerLogRemoved<T>(file: string, run: () => Promise<T> | T): Promise<T>;
