import { expect, it } from "vitest";
import {
	githubAvatarColor,
	githubAvatarLetter,
	hashGithubLogin,
	resolveGithubAvatarUrl,
} from "./github-avatar";

it("derives stable avatar colors from login hashes", () => {
	expect(githubAvatarColor("octocat")).toBe(githubAvatarColor("octocat"));
	expect(githubAvatarColor("octocat")).not.toBe(githubAvatarColor("hubot"));
	expect(hashGithubLogin("octocat")).toBe(hashGithubLogin("octocat"));
});

it("builds avatar urls and fallback letters for bots", () => {
	expect(resolveGithubAvatarUrl("dependabot[bot]")).toBe(
		"https://avatars.githubusercontent.com/dependabot%5Bbot%5D?size=64",
	);
	expect(resolveGithubAvatarUrl("octocat", "https://cdn.example/a.png")).toBe(
		"https://cdn.example/a.png",
	);
	expect(githubAvatarLetter("dependabot[bot]")).toBe("D");
	expect(githubAvatarLetter("")).toBe("?");
	expect(githubAvatarLetter(null)).toBe("?");
	expect(githubAvatarLetter(undefined)).toBe("?");
	expect(githubAvatarLetter("   ")).toBe("?");
	expect(githubAvatarLetter("___")).toBe("_");
	expect(githubAvatarColor("")).toBe("#0f766e");
	expect(githubAvatarColor("   ")).toBe("#0f766e");
	expect(resolveGithubAvatarUrl(null)).toBeNull();
	expect(resolveGithubAvatarUrl(undefined)).toBeNull();
	expect(resolveGithubAvatarUrl("   ")).toBeNull();
	expect(resolveGithubAvatarUrl("octocat", "   ", 128)).toBe(
		"https://avatars.githubusercontent.com/octocat?size=128",
	);
});
