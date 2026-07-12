import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";

import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

export function fdBinaryNames(platform: NodeJS.Platform): string[] {
	return platform === "win32" ? ["fd.exe", "fdfind.exe", "fd", "fdfind"] : ["fd", "fdfind"];
}

const FD_BINARY_NAMES = fdBinaryNames(process.platform);

// pi 본체의 fd 경로 해석은 확장 API로 노출되지 않으므로, 커스텀 에디터에서
// CombinedAutocompleteProvider를 재사용하려면 fd 경로를 직접 찾아 넘겨야 한다.
export function createFileAutocompleteProvider(cwd: string): AutocompleteProvider {
	return Object.assign(new CombinedAutocompleteProvider([], cwd, findAutocompleteBinary(FD_BINARY_NAMES)), {
		triggerCharacters: ["@"],
	});
}

export function findAutocompleteBinary(binaryNames: readonly string[]): string | null {
	const pathValue = process.env.PATH;
	if (!pathValue) return null;

	const directories = pathValue.split(delimiter).filter(Boolean);
	for (const binaryName of binaryNames) {
		const executablePath = directories
			.map((directory) => join(directory, binaryName))
			.find((candidate) => isExecutableFile(candidate));
		if (executablePath) return executablePath;
	}

	return null;
}

function isExecutableFile(path: string): boolean {
	try {
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}
