type CommandResult = { code: number; stdout: string; stderr: string };
type RunOptions = {
	cwd?: string;
	quiet?: boolean;
	timeoutMs?: number;
	onAuthUrl?: (url: string) => void;
	tty?: boolean;
};
type Runner = (command: string, args: string[], options: RunOptions) => Promise<CommandResult>;

export function runCommand(command: string, args: string[], options?: RunOptions): Promise<CommandResult>;
export function deployPackage(options: {
	root: string;
	slug: string;
	run?: Runner;
	onAuthUrl?: (url: string) => void;
	wait?: (ms: number) => Promise<void>;
}): Promise<string>;
