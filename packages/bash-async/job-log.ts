import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const MAX_RETAINED_LINES = 2_000;
export const MAX_RAW_LOG_BYTES = 20 * 1024 * 1024;
export const MAX_RETURNED_LINES = 200;
export const MAX_RETURNED_BYTES = 5 * 1024;
export const MAX_RETAINED_LINE_BYTES = 64 * 1024;
export const MAX_RETAINED_TEXT_BYTES = 1024 * 1024;
export const TRUNCATION_MARKER = "\n[bash_async log truncated after 20 MiB]\n";
export const IN_MEMORY_LINE_TRUNCATION_MARKER = "[bash_async in-memory line truncated]";

export interface JobLogOptions {
	path: string;
	maxRetainedLines?: number;
	maxRetainedTextBytes?: number;
	maxRawBytes?: number;
}

export interface JobLogOutputOptions {
	lines?: number;
	outputOffset?: number;
	incremental?: boolean;
}

export interface JobLogOutput {
	text: string;
	lines: string[];
	startOffset: number;
	nextOffset: number;
	retainedFromOffset: number;
	logPath: string;
	logBytes: number;
	logTruncated: boolean;
	warning?: string;
}

export interface JobLogSummary {
	path: string;
	bytes: number;
	truncated: boolean;
	sealed: boolean;
	closed: boolean;
	retainedFromOffset: number;
	retainedLineCount: number;
	retainedTextBytes: number;
}

function clampLines(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 50;
	return Math.min(MAX_RETURNED_LINES, Math.max(1, Math.floor(value)));
}

function clampOffset(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	let result = "";
	let used = 0;
	for (const character of value) {
		const bytes = Buffer.byteLength(character);
		if (used + bytes > maxBytes) break;
		result += character;
		used += bytes;
	}
	return result;
}

export class JobLog {
	readonly path: string;
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxRetainedLines: number;
	private readonly maxRetainedTextBytes: number;
	private readonly maxRawBytes: number;
	private readonly truncationMarker = Buffer.from(TRUNCATION_MARKER, "utf8");
	private readonly fileDescriptor: number;
	private lines: string[] = [];
	private retainedTextBytes = 0;
	private partialLine = "";
	private partialLineTruncated = false;
	private retainedFromOffset = 0;
	private incrementalCursor = 0;
	private bytes = 0;
	private truncated = false;
	private isSealed = false;
	private isClosed = false;

	constructor(options: JobLogOptions) {
		this.path = options.path;
		this.maxRetainedLines = Math.max(1, Math.floor(options.maxRetainedLines ?? MAX_RETAINED_LINES));
		this.maxRetainedTextBytes = Math.max(
			MAX_RETAINED_LINE_BYTES,
			Math.floor(options.maxRetainedTextBytes ?? MAX_RETAINED_TEXT_BYTES),
		);
		this.maxRawBytes = Math.max(
			Buffer.byteLength(TRUNCATION_MARKER),
			Math.floor(options.maxRawBytes ?? MAX_RAW_LOG_BYTES),
		);
		mkdirSync(dirname(options.path), { recursive: true });
		this.fileDescriptor = openSync(options.path, "w", 0o600);
	}

	append(data: Buffer | string): void {
		if (this.isSealed) return;
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		this.appendRaw(buffer);
		this.consumeDecoded(this.decoder.write(buffer));
	}

	seal(): void {
		if (this.isSealed) return;
		this.isSealed = true;
		this.consumeDecoded(this.decoder.end());
		if (this.partialLine !== "") {
			this.pushLine(this.partialLine);
			this.partialLine = "";
		}
		this.partialLineTruncated = false;
	}

	close(): void {
		if (this.isClosed) return;
		this.seal();
		closeSync(this.fileDescriptor);
		this.isClosed = true;
	}

	output(options: JobLogOutputOptions = {}): JobLogOutput {
		const lineLimit = clampLines(options.lines);
		const requestedOffset = clampOffset(
			options.outputOffset ??
				(options.incremental ? this.incrementalCursor : Math.max(this.retainedFromOffset, this.nextOffset - lineLimit)),
		);
		const startOffset = Math.max(requestedOffset, this.retainedFromOffset);
		const startIndex = Math.min(this.lines.length, startOffset - this.retainedFromOffset);
		const selected = this.lines.slice(startIndex, startIndex + lineLimit);
		const boundedLines = this.limitOutputBytes(selected);
		const nextOffset = startOffset + boundedLines.length;
		if (options.incremental) this.incrementalCursor = nextOffset;

		const warning =
			requestedOffset < this.retainedFromOffset
				? `Output before offset ${this.retainedFromOffset} is no longer retained. Read ${this.path} for exact older output.`
				: undefined;
		return {
			text: boundedLines.join("\n"),
			lines: boundedLines,
			startOffset,
			nextOffset,
			retainedFromOffset: this.retainedFromOffset,
			logPath: this.path,
			logBytes: this.bytes,
			logTruncated: this.truncated,
			warning,
		};
	}

	tail(lines = 20): string[] {
		return this.lines.slice(-clampLines(lines));
	}

	summary(): JobLogSummary {
		return {
			path: this.path,
			bytes: this.bytes,
			truncated: this.truncated,
			sealed: this.isSealed,
			closed: this.isClosed,
			retainedFromOffset: this.retainedFromOffset,
			retainedLineCount: this.lines.length,
			retainedTextBytes: this.retainedTextBytes,
		};
	}

	private get nextOffset(): number {
		return this.retainedFromOffset + this.lines.length;
	}

	private appendRaw(buffer: Buffer): void {
		if (this.truncated) return;
		const bytesBeforeMarker = this.maxRawBytes - this.truncationMarker.length;
		const writableBytes = Math.max(0, Math.min(buffer.length, bytesBeforeMarker - this.bytes));
		if (writableBytes > 0) {
			this.writeRaw(buffer.subarray(0, writableBytes));
			this.bytes += writableBytes;
		}
		if (writableBytes < buffer.length) {
			this.writeRaw(this.truncationMarker);
			this.bytes += this.truncationMarker.length;
			this.truncated = true;
		}
	}

	private writeRaw(buffer: Buffer): void {
		let offset = 0;
		while (offset < buffer.length) {
			offset += writeSync(this.fileDescriptor, buffer, offset, buffer.length - offset);
		}
	}

	private consumeDecoded(decoded: string): void {
		let remaining = decoded;
		while (true) {
			const newline = remaining.indexOf("\n");
			if (newline === -1) {
				this.appendPartialLine(remaining);
				return;
			}
			this.appendPartialLine(remaining.slice(0, newline));
			this.pushLine(this.partialLine.endsWith("\r") ? this.partialLine.slice(0, -1) : this.partialLine);
			this.partialLine = "";
			this.partialLineTruncated = false;
			remaining = remaining.slice(newline + 1);
		}
	}

	private appendPartialLine(value: string): void {
		if (this.partialLineTruncated || value === "") return;
		const markerBytes = Buffer.byteLength(IN_MEMORY_LINE_TRUNCATION_MARKER);
		const availableBytes = MAX_RETAINED_LINE_BYTES - markerBytes - Buffer.byteLength(this.partialLine);
		if (Buffer.byteLength(value) <= availableBytes) {
			this.partialLine += value;
			return;
		}
		this.partialLine += truncateUtf8(value, Math.max(0, availableBytes));
		this.partialLine += IN_MEMORY_LINE_TRUNCATION_MARKER;
		this.partialLineTruncated = true;
	}

	private pushLine(line: string): void {
		this.lines.push(line);
		this.retainedTextBytes += Buffer.byteLength(line);
		let dropped = 0;
		while (this.lines.length - dropped > this.maxRetainedLines || this.retainedTextBytes > this.maxRetainedTextBytes) {
			const removed = this.lines[dropped];
			this.retainedTextBytes -= Buffer.byteLength(removed);
			dropped++;
		}
		if (dropped === 0) return;
		this.lines.splice(0, dropped);
		this.retainedFromOffset += dropped;
		if (this.incrementalCursor < this.retainedFromOffset) this.incrementalCursor = this.retainedFromOffset;
	}

	private limitOutputBytes(lines: string[]): string[] {
		const result: string[] = [];
		let used = 0;
		for (const line of lines) {
			const separatorBytes = result.length === 0 ? 0 : 1;
			const remaining = MAX_RETURNED_BYTES - used - separatorBytes;
			if (remaining <= 0) break;
			const boundedLine = truncateUtf8(line, remaining);
			result.push(boundedLine);
			used += separatorBytes + Buffer.byteLength(boundedLine);
			if (boundedLine.length < line.length) break;
		}
		return result;
	}
}
