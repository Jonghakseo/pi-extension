export interface FileLockMarker {
	token: string;
	privatePath: string;
}

export function tryAcquireFileLock(lockPath: string): FileLockMarker | undefined;
export function releaseFileLock(lockPath: string, marker: FileLockMarker | undefined): void;
export function withFileLock<T>(lockPath: string, action: () => T): T;
export function withStoreLock<T>(cronDir: string, action: () => T): T;
export function writeAtomicFile(path: string, content: string, encoding?: BufferEncoding): void;
