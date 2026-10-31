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
});
