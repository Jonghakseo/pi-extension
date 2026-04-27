import * as os from "node:os";
import * as path from "node:path";

export const WIDGET_KEY = "setup-sh";
export const STATUS_KEY = "setup-sh";
export const STATE_ROOT = path.join(os.homedir(), ".pi", "agent", "state", "setup-sh");
export const LOCK_STALE_MS = 12 * 60 * 60 * 1000;
export const PENDING_AFTER_MS = 60 * 1000;
export const WIDGET_REFRESH_MS = 1000;
export const LOG_TAIL_LINES = 8;
