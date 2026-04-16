import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl } from "./project-id.ts";

// ---------------------------------------------------------------------------
// normalizeRemoteUrl — git URL normalization
// ---------------------------------------------------------------------------

describe("normalizeRemoteUrl", () => {
	it("should normalize HTTPS URL", () => {
		expect(normalizeRemoteUrl("https://github.com/acme-org/my-app.git")).toBe("github-com-acme-org-my-app");
	});

	it("should normalize SSH URL", () => {
		expect(normalizeRemoteUrl("git@github.com:acme-org/my-app.git")).toBe("github-com-acme-org-my-app");
	});

	it("should strip trailing .git", () => {
		expect(normalizeRemoteUrl("https://github.com/org/repo.git")).toBe("github-com-org-repo");
	});

	it("should handle URL without .git suffix", () => {
		expect(normalizeRemoteUrl("https://github.com/org/repo")).toBe("github-com-org-repo");
	});

	it("should strip trailing slashes", () => {
		expect(normalizeRemoteUrl("https://github.com/org/repo/")).toBe("github-com-org-repo");
	});

	it("should produce the same slug for HTTPS and SSH of the same repo", () => {
		const https = normalizeRemoteUrl("https://github.com/acme-org/my-app.git");
		const ssh = normalizeRemoteUrl("git@github.com:acme-org/my-app.git");
		expect(https).toBe(ssh);
	});

	it("should handle ssh:// protocol", () => {
		expect(normalizeRemoteUrl("ssh://git@github.com/org/repo.git")).toBe("github-com-org-repo");
	});

	it("should handle http:// protocol", () => {
		expect(normalizeRemoteUrl("http://github.com/org/repo")).toBe("github-com-org-repo");
	});

	it("should handle GitLab URLs", () => {
		expect(normalizeRemoteUrl("git@gitlab.com:group/subgroup/repo.git")).toBe("gitlab-com-group-subgroup-repo");
	});

	it("should handle self-hosted domains", () => {
		expect(normalizeRemoteUrl("https://git.company.internal/team/project.git")).toBe(
			"git-company-internal-team-project",
		);
	});

	it("should handle whitespace around URL", () => {
		expect(normalizeRemoteUrl("  https://github.com/org/repo.git  ")).toBe("github-com-org-repo");
	});

	it("should lowercase the result", () => {
		expect(normalizeRemoteUrl("https://github.com/Org/REPO.git")).toBe("github-com-org-repo");
	});

	it("should collapse multiple non-alphanumeric characters", () => {
		expect(normalizeRemoteUrl("https://github.com/org--name/repo__name.git")).toBe("github-com-org-name-repo-name");
	});

	it("should strip leading/trailing hyphens from result", () => {
		const result = normalizeRemoteUrl("https://github.com/org/repo");
		expect(result).not.toMatch(/^-/);
		expect(result).not.toMatch(/-$/);
	});
});
