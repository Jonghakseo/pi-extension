// Git hooks export repository-scoped variables such as GIT_DIR. Tests that create
// throwaway repositories would otherwise write commits and config (core.bare,
// user.name) into the repository running the hook.
for (const name of Object.keys(process.env)) {
	if (
		/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(
			name,
		)
	) {
		delete process.env[name];
	}
}
