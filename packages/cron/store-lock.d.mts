export function withFileLock<T>(lockPath: string, action: () => T): T;
export function withStoreLock<T>(cronDir: string, action: () => T): T;
export function writeAtomicFile(path: string, content: string, encoding?: BufferEncoding): void;
