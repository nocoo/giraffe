import type { RefreshDay } from "../../../lib/refresh-types";

const catalogFields = `id name nameWithOwner url description isPrivate isArchived isFork isEmpty pushedAt createdAt diskUsage stargazerCount forkCount visibility owner { login } primaryLanguage { name }`;
const page = `pageInfo { hasNextPage endCursor }`;
const issueFields = `id number title url state createdAt updatedAt closedAt author { login } labels(first:20) { nodes { name color } } comments { totalCount }`;
const prFields = `${issueFields} mergedAt isDraft additions deletions baseRefName headRefName reviewDecision mergeable mergeStateStatus`;
export const accountQuery = `query RefreshAccount($after:String,$since:DateTime!,$until:DateTime!) {
 viewer { login avatarUrl repositories(first:100,after:$after,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],orderBy:{field:NAME,direction:ASC}) { totalCount ${page} nodes { ${catalogFields} } }
 contributionsCollection(from:$since,to:$until) { restrictedContributionsCount contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } }
 rateLimit { remaining resetAt }
}`;
export function repositoryQuery(days: RefreshDay[], issues: boolean, prs: boolean) {
	return `query RefreshRepository($id:ID!${days.map((_, index) => `,$since${index}:GitTimestamp!,$until${index}:GitTimestamp!`).join("")}) {
 node(id:$id) { ... on Repository { ${catalogFields}
 defaultBranchRef { name target { ... on Commit { oid history { totalCount } ${days.map((_, index) => `day${index}:history(since:$since${index},until:$until${index}) { totalCount }`).join(" ")} } } }
 languages(first:100,orderBy:{field:SIZE,direction:DESC}) { totalSize pageInfo { hasNextPage } edges { size node { name } } }
 repositoryTopics(first:100) { nodes { topic { name } } }
 openIssues:issues(states:OPEN) { totalCount } closedIssues:issues(states:CLOSED) { totalCount }
 openPrs:pullRequests(states:OPEN) { totalCount } closedPrs:pullRequests(states:CLOSED) { totalCount } mergedPrs:pullRequests(states:MERGED) { totalCount }
 releases { totalCount }
 ${issues ? `issues(first:100,orderBy:{field:UPDATED_AT,direction:DESC}) { ${page} nodes { ${issueFields} } }` : ""}
 ${prs ? `pullRequests(first:100,orderBy:{field:UPDATED_AT,direction:DESC}) { ${page} nodes { ${prFields} } }` : ""}
 } } rateLimit { remaining resetAt }
 }`;
}
export function itemQuery(stream: "issues" | "prs") {
	const field = stream === "prs" ? "pullRequests" : "issues";
	return `query RefreshItems($id:ID!,$after:String!) { node(id:$id) { ... on Repository { ${field}(first:100,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}) { ${page} nodes { ${stream === "prs" ? prFields : issueFields} } } } } }`;
}
