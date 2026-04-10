import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type RegisteredTool = {
	name: string;
	execute?: (...args: unknown[]) => unknown;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
};

type RegisteredCommand = {
	description?: string;
	handler: (args: string, ctx: ExtensionContext) => unknown;
	getArgumentCompletions?: (prefix: string) => unknown;
};

type RegisteredProvider = {
	api: string;
	streamSimple: (...args: unknown[]) => unknown;
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type MessageRenderer = (...args: unknown[]) => unknown;

export type ExtensionApiMock = {
	api: ExtensionAPI;
	tools: Map<string, RegisteredTool>;
	commands: Map<string, RegisteredCommand>;
	providers: Map<string, RegisteredProvider>;
	handlers: Map<string, EventHandler[]>;
	messageRenderers: Map<string, MessageRenderer>;
	sentMessages: unknown[];
	userMessages: Array<{ message: string; options?: unknown }>;
	appendedEntries: Array<{ type: string; data: unknown }>;
	getTool(name: string): RegisteredTool;
	getCommand(name: string): RegisteredCommand;
	getProvider(name: string): RegisteredProvider;
	getHandlers(name: string): EventHandler[];
	getMessageRenderer(name: string): MessageRenderer;
	setSessionName(name: string): void;
	getSessionName(): string;
};

export function createExtensionApiMock(initialSessionName = ""): ExtensionApiMock {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const providers = new Map<string, RegisteredProvider>();
	const handlers = new Map<string, EventHandler[]>();
	const messageRenderers = new Map<string, MessageRenderer>();
	const sentMessages: unknown[] = [];
	const userMessages: Array<{ message: string; options?: unknown }> = [];
	const appendedEntries: Array<{ type: string; data: unknown }> = [];
	let sessionName = initialSessionName;

	const api = {
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerProvider(name: string, provider: RegisteredProvider) {
			providers.set(name, provider);
		},
		registerMessageRenderer(name: string, renderer: MessageRenderer) {
			messageRenderers.set(name, renderer);
		},
		on(name: string, handler: EventHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		sendMessage(message: unknown) {
			sentMessages.push(message);
		},
		sendUserMessage(message: string, options?: unknown) {
			userMessages.push({ message, options });
		},
		appendEntry<T>(type: string, data: T) {
			appendedEntries.push({ type, data });
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		getSessionName() {
			return sessionName;
		},
	} as unknown as ExtensionAPI;

	return {
		api,
		tools,
		commands,
		providers,
		handlers,
		messageRenderers,
		sentMessages,
		userMessages,
		appendedEntries,
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) {
				throw new Error(`Tool not registered: ${name}`);
			}
			return tool;
		},
		getCommand(name: string) {
			const command = commands.get(name);
			if (!command) {
				throw new Error(`Command not registered: ${name}`);
			}
			return command;
		},
		getProvider(name: string) {
			const provider = providers.get(name);
			if (!provider) {
				throw new Error(`Provider not registered: ${name}`);
			}
			return provider;
		},
		getHandlers(name: string) {
			return handlers.get(name) ?? [];
		},
		getMessageRenderer(name: string) {
			const renderer = messageRenderers.get(name);
			if (!renderer) {
				throw new Error(`Message renderer not registered: ${name}`);
			}
			return renderer;
		},
		setSessionName(name: string) {
			sessionName = name;
		},
		getSessionName() {
			return sessionName;
		},
	};
}
