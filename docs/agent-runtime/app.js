(() => {
	const modes = {
		dry: {
			summary:
				"Rehearse only. No workspace tools or online writes. Models still run in the real CLI.",
			command: "bun run agent work --once --dry-run --limit 5",
			title: "Describe · do not execute",
			policy: "no pull, install, edits, checks, commits or publication",
		},
		local: {
			summary: "Real local work + reports. Atomic commits; no push or issue closure.",
			command: "bun run agent work --once --no-push --limit 2 --repos nocoo/backy,nocoo/r2shot",
			title: "Verify · keep local",
			policy: "workers never push or close issues",
		},
		publish: {
			summary:
				"CLI invocation is an explicit execution grant. Host may push, verify, then close issues.",
			command: "bun run agent work --once --limit 2 --repos nocoo/backy,nocoo/r2shot",
			title: "Verify → push → close",
			policy: "host-only publication · never worker authority",
		},
	};
	const nodes = {
		api: {
			kind: "CLOUD / OBSERVATIONS & PUBLICATION",
			title: "Giraffe web & API",
			summary:
				"The cloud stores observations and published agent resources. Model execution stays local.",
			facts: [
				[
					"Read snapshots, not upstream",
					"Web automatic refresh saves repository, issue, PR and CI/factory sources. The local daemon reads snapshots, not a second full collection. GET never silently refreshes GitHub.",
				],
				[
					"Two authentication boundaries",
					"The dashboard uses Cloudflare Access. /api/v1 uses scoped, expiring, account-bound bearer tokens.",
				],
				[
					"Write reports, not observations",
					"Existing jobs/records carry bounded progress. The online /work desk renders typed repository rows and events. This offline map only simulates the flow and never starts work. GitHub observations remain read-only.",
				],
			],
			permission: "Scoped API CRUD only. No cloud model credentials or cloud inference.",
			source: "docs/11-agent-api.md",
		},
		controller: {
			kind: "LOCAL / ORCHESTRATOR ROLE",
			title: "Astra orchestrator",
			summary:
				"One root conversation plans the portfolio. TypeScript code owns the workflow transitions and side effects.",
			facts: [
				[
					"Rank observations; authorize typed tasks",
					"Retain all observed issues/PRs for ranking. Integrated kinds: dependency upgrades, exact case-sensitive [CO] non-draft PR fixes, recurring main CI/CD investigation. Fake APIs/models and temporary SQLite/native Git fixtures validate code, not real unattended PR/CI runs. Preserve dirt; ahead main commits are not dirty.",
				],
				[
					"A model plan is not authorization",
					"Zod validates the handoff; the host rejects missing or invented scope. Workers cannot publish just because a model asks.",
				],
				[
					"Configured, not fixed",
					"Recorded run: gpt-6-astra, thinking off. Role mappings come from local config, not a mandatory on-call architect pattern.",
				],
			],
			permission:
				"Controller conversation: structured planning. Host: inspect, sequence, verify and conditionally publish.",
			source: "packages/agent/src/work-coordinator.ts",
		},
		jev: {
			kind: "LOCAL CLIENT / JEV-LATEST",
			title: "Jev decision layer",
			summary:
				"Two bounded decisions: prioritize the portfolio, then select a worker profile for each repository.",
			facts: [
				[
					"At most 25 repositories per request",
					"One choice question per repository includes all saved open issues and PRs. The recorded 52 nonempty repositories became 25 + 25 + 2.",
				],
				[
					"Model + thinking selection",
					"Choose among executor low, executor medium and orchestrator high. Recorded routes: Backy → Astra/high; R2Shot → Sol/low.",
				],
				[
					"Not a per-tool decision engine",
					"It does not pick every file or shell command. Returned preferences inform the controller; no invented confidence bars are shown here.",
				],
			],
			permission:
				"Decision requests only. No workspace writes, arbitrary tools or independent worker spawning.",
			source: "packages/agent/src/work-priority.ts",
		},
		state: {
			kind: "LOCAL / PI DURABLE + SQLITE",
			title: "Local runtime state",
			summary:
				"Persistent means conversation history survives. It does not mean a daemon is automatically installed.",
			facts: [
				[
					"A single local owner",
					"An SQLite transaction lock permits one Harness owner per service/account. Conversations reuse IDs across assignments.",
				],
				[
					"Single schedule and execution runtime",
					"One live work SQLite file, account lock and cron. Dry run uses isolated memory under the same account lock; no old watch/repair engines remain.",
				],
				[
					"Bounded persisted recovery",
					"Source-set task identity, rounds, findings and pushed SHA persist; priority order cannot reset rounds and mode/scope cannot change mid-occurrence. Closure/follow-up and terminal Web delivery resume without replaying native work. At most 20 review rounds and three ten-minute checks. /work renders repository summaries. Historical acceptance is not current unattended proof.",
				],
			],
			permission:
				"Local config and credentials only. Neither secrets nor runtime SQLite are sent to D1.",
			source: "packages/agent/src/work-daemon.ts",
		},
		preparation: {
			kind: "RESIDENT / EXECUTOR ROLE",
			title: "Workspace preparation",
			summary:
				"One shared conversation prepares existing personal repositories before each worker receives the task.",
			facts: [
				[
					"Keep main and user work",
					"Verify origin, hooks and owned repository scope. Fetch and fast-forward only when safe; preserve ahead commits and approved dirt.",
				],
				[
					"Establish the baseline",
					"Install from an approved temporary mirror. Record failed baseline checks, then require final tests and independent review; never weaken tests or hooks.",
				],
				[
					"Evidence from this assignment",
					"A prepare call must occur now. An earlier successful or failed call cannot satisfy the current handoff.",
				],
			],
			permission:
				"Live: one prepare operation. Dry run: describe the handoff, with no workspace action tool.",
			source: "packages/agent/src/work-workspace.ts",
		},
		workers: {
			kind: "PERSISTENT / ONE WORKER PER REPOSITORY",
			title: "Repository workers",
			summary:
				"Each persistent worker gets the verified main directory, typed tasks and Jev-selected model profile. The host executes repository pairs sequentially with a distinct read-only reviewer.",
			facts: [
				[
					"Inspect before changing",
					"Dependency requests need verified stable versions; explicit critical-package majors require manual attention. [CO] fixes need complete patches and frozen PR head/base plus live main SHA. CI/CD needs exact failed SHA and job/step evidence; recurring failure does not prove a flaky test cause.",
				],
				[
					"Atomic, buildable changes",
					"Commit completed tasks with normal hooks and passing final checks. Noncritical majors are not blanket-blocked. No test deletion, coverage reduction or hook bypass. Already-current tasks need evidence, not empty commits.",
				],
				[
					"Bounded tool capabilities",
					"read, write, latest, install, check, commit and satisfied. No arbitrary shell, push or issue-close operation. Dirty baseline paths remain protected.",
				],
			],
			permission:
				"Live: scoped local writes and commits. Dry run: structured rehearsal only. Native repository scripts are not OS-isolated.",
			source: "packages/agent/src/work-coordinator.ts",
		},
		publication: {
			kind: "HOST CODE / PUBLICATION BOUNDARY",
			title: "Verify before publication",
			summary:
				"The host checks actual work and live issue scope. A model claiming success is insufficient.",
			facts: [
				[
					"Exact-revision evidence",
					"Require every issue to be committed or verified current. Re-run checks; match main HEAD, workspace status and preserved baseline changes.",
				],
				[
					"Mode determines side effects",
					"An independent read-only reviewer approves exact checked HEAD in at most 20 persisted rounds. --no-push stops locally. Host pushes main, persists SHA, closes completed dependency issues and follows exact-SHA CI at ten-minute intervals, at most three checks. PR merge/closure is report-only.",
				],
				[
					"Do not overclaim acceptance",
					"Dry-run success proves scheduling only. Published reports with stale or missing coverage cannot imply successful CI or deployment.",
				],
			],
			permission:
				"Only the host publishes. No force push, hook bypass, reset, stash, branch or worktree creation.",
			source: "packages/agent/src/work-coordinator.ts",
		},
	};
	nodes.reviewer = {
		kind: "PERSISTENT / DISTINCT REVIEWER PER REPOSITORY",
		title: "Independent reviewer",
		summary:
			"A separate read-only conversation pairs with each worker; it cannot edit, commit or push.",
		facts: [
			[
				"Fix / check / review",
				"At most 20 persisted rounds. Failed checks consume a round; findings return to the same Worker. Exhaustion cannot publish; recovery cannot create a twenty-first fix.",
			],
			[
				"Exact-revision approval",
				"Review every commit ahead of origin/main and preserved dirty paths, not just the last commit. Approval belongs to exact checked HEAD; changed HEAD invalidates it.",
			],
			[
				"Independent acceptance",
				"Read-only review is distinct from worker self-checks and domain reports. Baseline failure is visible, not a blocker for repairing code; final tests and independent review must pass.",
			],
		],
		permission:
			"Read-only local evidence. No writes, commits, push, PR merge/closure or credential/infrastructure repair.",
		source: "packages/agent/src/work-review.ts",
	};
	nodes.followup = {
		kind: "HOST / PERSISTED POST-PUSH FOLLOW-UP",
		title: "Exact-SHA follow-up",
		summary: "Read bounded live Actions evidence for the exact pushed SHA, not deployment success.",
		facts: [
			[
				"Bounded across restart",
				"Wait 10 minutes between checks, with at most three checks across restart. Persist outcome: passed, failed, pending or timeout.",
			],
			[
				"Missing is not green",
				"Missing, partial, cancelled or skipped/neutral-only evidence is not passed. Only complete successful workflow evidence passes; evidenced failures are failed.",
			],
			[
				"No release automation",
				"No automatic deployment, release or rollback. PR merge/closure is report-only; only completed dependency issues may close after the push marker persists.",
			],
		],
		permission:
			"Host-only bounded Actions reads after publication. No deployment mutations or ZIP-log download in task evidence helpers.",
		source: "packages/agent/src/work-followup.ts",
	};
	const domains = {
		issues: [
			"Issues analyst",
			"Assess backlog, dependency risks and actionable maintenance; an open issue alone is not a verified incident.",
		],
		prs: [
			"PR analyst",
			"Assess saved PR readiness. Missing diffs, checks or current review evidence cannot justify a merge-ready verdict.",
		],
		ci: [
			"CI analyst",
			"Assess observed workflow outcomes and coverage. Pending, skipped or stale evidence cannot be called successful current CI.",
		],
		cd: [
			"CD analyst",
			"Assess delivery evidence independently from CI. Release counts do not prove that a deployment is healthy.",
		],
	};
	for (const [domain, [title, summary]] of Object.entries(domains)) {
		nodes[domain] = {
			kind: `RESIDENT / ${domain.toUpperCase()} / EXECUTOR ROLE`,
			title,
			summary,
			facts: [
				[
					"Four parallel conversations",
					"Issues, PR, CI and CD analysis runs alongside portfolio planning. These conversations analyze; they do not repair repositories.",
				],
				[
					"Saved, bounded evidence",
					"Saved provenance and bounded detailed evidence remain visible. Omitted, missing and stale evidence is not successful coverage. Reports never substitute for independent repair acceptance.",
				],
				[
					"Validated online reports",
					"Live modes publish schema-validated reports with source provenance. Dry run prints the result without online writes.",
				],
			],
			permission:
				"Read observations + submit structured findings. No workspace tools. Recorded role: gpt-6.1-sol / off.",
			source: "packages/agent/src/work-analysis.ts",
		};
	}
	const stages = [
		{
			label: "Read snapshot",
			node: "api",
			actor: "api",
			color: "blue",
			text: "Read saved API observations. No upstream refresh is triggered by GET.",
			log: "65 repositories · 458 issues · 6 PRs. These are recorded sample counts, not live data.",
		},
		{
			label: "Rank & analyze",
			node: "jev",
			actor: "jev + analysts",
			color: "green",
			text: "Jev ranks in batches while four resident domain conversations analyze independently.",
			log: "52 nonempty repositories → 25 + 25 + 2. Issues / PR / CI / CD analysis runs in parallel.",
		},
		{
			label: "Plan scope",
			node: "controller",
			actor: "astra",
			color: "purple",
			text: "Controller orders integrated dependency / exact [CO] / recurring CI tasks; host validates identity, current evidence and workspace safety. Fixture validation is not live unattended acceptance.",
			log: "Original issue / PR / run identities. Keep unrelated observations for ranking, not repair scope.",
		},
		{
			label: "Route worker",
			node: "jev",
			actor: "jev",
			color: "green",
			text: "Choose a configured model/thinking profile for each repository before its worker starts.",
			log: "Recorded choices: backy → Astra/high; r2shot → Sol/low. Not a fixed model rule.",
		},
		{
			label: "Prepare main",
			node: "preparation",
			actor: "preparation",
			color: "cyan",
			text: "Shared preparation uses existing personal main; preserves dirt/ahead commits and records baseline checks. No clones, branches or worktrees.",
			log: "prepare → safe fast-forward → frozen install → UT / lint / types / build → validated handoff.",
		},
		{
			label: "Repair & check",
			node: "workers",
			actor: "worker",
			color: "cyan",
			text: "Persistent per-repository worker investigates evidence, fixes assigned code, checks and atomically commits with normal hooks.",
			log: "Dependency versions / [CO] full diff / CI failed SHA + jobs. No invented flaky cause; workers never push or merge PRs.",
		},
		{
			label: "Independent review",
			short: "Review ↶ max 20",
			node: "reviewer",
			actor: "reviewer",
			color: "blue",
			text: "Distinct read-only Reviewer checks all ahead commits and exact tested HEAD. Findings return to Worker; fix / check / review is capped at 20 persisted rounds.",
			log: "Worker ↔ Reviewer, max 20. Failed checks consume rounds; exhausted or changed-HEAD approval cannot push.",
		},
		{
			label: "Publication boundary",
			short: "Verify & publish",
			node: "publication",
			actor: "host",
			color: "green",
			text: "Verify exact HEAD. No push. No issue closure.",
			log: "Local-only boundary: final checks + exact committed HEAD. No push, no issue closure.",
		},
		{
			label: "Post-push follow-up",
			short: "Follow-up 10m × 3",
			node: "followup",
			actor: "host",
			color: "green",
			text: "No push in local-only mode, so no post-push follow-up. Review and commits remain local.",
			log: "Publication-only: exact pushed SHA, every 10 minutes, at most three checks across restart. No deploy/release/rollback.",
		},
		{
			label: "Finish handoff",
			node: "state",
			actor: "runtime",
			color: "blue",
			text: "Complete one occurrence; normal work stays resident on cron. --once exits after this occurrence. No OS service is automatically installed.",
			log: "Persist progress + heartbeat. Resident work awaits cron; --once releases the lock after completion. Dry run shares the lock but isolates memory.",
		},
	];
	const state = { mode: "local", stage: 0, node: "controller", timer: null };
	const element = (id) => document.getElementById(id);
	const sourcePath = (path) => (path.startsWith("docs/") ? `../${path.slice(5)}` : `../../${path}`);
	const stepButtons = stages.map((stage, index) => {
		const button = document.createElement("button");
		button.type = "button";
		button.setAttribute("aria-label", `${String(index + 1).padStart(2, "0")} ${stage.label}`);
		const number = document.createElement("span");
		number.textContent = String(index + 1).padStart(2, "0");
		button.append(number, document.createTextNode(stage.short ?? stage.label));
		button.addEventListener("click", () => {
			stop();
			setStage(index);
		});
		element("steps").append(button);
		return button;
	});

	function inspect(key) {
		state.node = key;
		const node = nodes[key];
		element("detail-kind").textContent = node.kind;
		element("detail-title").textContent = node.title;
		element("detail-summary").textContent =
			key === "followup" && state.mode !== "publish"
				? `Not executed in ${state.mode === "dry" ? "dry-run" : "local-only"} mode. ${node.summary}`
				: node.summary;
		element("detail-permissions").textContent = node.permission;
		element("detail-source").href = sourcePath(node.source);
		element("detail-source").textContent = `↗ ${node.source.split("/").at(-1)}`;
		element("detail-body").replaceChildren(
			...node.facts.map(([title, description]) => {
				const paragraph = document.createElement("p");
				paragraph.className = "detail-item";
				const heading = document.createElement("strong");
				heading.textContent = title;
				paragraph.append(heading, document.createTextNode(description));
				return paragraph;
			}),
		);
		for (const button of document.querySelectorAll("[data-node]")) {
			button.setAttribute("aria-pressed", String(button.dataset.node === key));
		}
	}

	function stageText(index, log = false) {
		if (state.mode === "dry" && index >= 4 && index <= 8) {
			return index >= 6
				? "Rehearsal only. No repository changes, online reports, push or issue closure."
				: `${index === 4 ? "Preparation" : "Worker"} explains the intended process only. No workspace action tool is available.`;
		}
		if (index === 1 && log)
			return `${stages[index].log} ${state.mode === "dry" ? "Print findings; no online reports." : "Publish validated reports to Giraffe."}`;
		if (index === 7 && state.mode === "publish")
			return "Host checks exact tested/reviewed HEAD → push main → verify remote SHA → persist push → close only completed dependency issues. PR merge/closure is report-only.";
		if (index === 8 && state.mode === "publish")
			return "Exact pushed SHA: every 10 minutes, at most three checks across restart. Missing/partial evidence stays pending or timeout, never green. No deploy/release/rollback.";
		return stages[index][log ? "log" : "text"];
	}

	function renderStage() {
		element("step-count").textContent =
			`${String(state.stage + 1).padStart(2, "0")} / ${String(stages.length).padStart(2, "0")}`;
		element("previous").disabled = state.stage === 0;
		element("next").disabled = state.stage === stages.length - 1;
		element("stage-outcome").textContent = stageText(state.stage);
		for (const [index, button] of stepButtons.entries()) {
			if (index === state.stage) button.setAttribute("aria-current", "step");
			else button.removeAttribute("aria-current");
			button.classList.toggle("done", index < state.stage);
		}
		for (const node of document.querySelectorAll(".node, .analysts")) {
			node.classList.toggle(
				"is-active",
				node.id === `node-${stages[state.stage].node}` ||
					(node.id === "node-analysts" && state.stage >= 1 && state.stage <= 5),
			);
		}
		element("session-log").replaceChildren(
			...stages.slice(Math.max(0, state.stage - 3), state.stage + 1).map((stage, offset) => {
				const index = Math.max(0, state.stage - 3) + offset;
				const row = document.createElement("li");
				const time = document.createElement("time");
				time.textContent = `step.${String(index + 1).padStart(2, "0")}`;
				const actor = document.createElement("strong");
				actor.className = stage.color;
				actor.textContent = stage.actor;
				const message = document.createElement("span");
				message.textContent = stageText(index, true);
				row.append(time, actor, message);
				return row;
			}),
		);
		drawConnections();
	}

	function setStage(index) {
		state.stage = Math.max(0, Math.min(stages.length - 1, index));
		inspect(stages[state.stage].node);
		renderStage();
	}

	function stop() {
		clearInterval(state.timer);
		state.timer = null;
		element("play").setAttribute("aria-label", "Play walkthrough");
		element("play").textContent = "▶ Play";
		document.body.classList.remove("playing");
	}

	function setMode(mode) {
		stop();
		state.mode = mode;
		const settings = modes[mode];
		for (const button of document.querySelectorAll("[data-mode]"))
			button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
		element("mode-summary").textContent = settings.summary;
		element("command").textContent = settings.command;
		element("publication-title").textContent = settings.title;
		element("publication-policy").textContent = settings.policy;
		element("followup-schedule").textContent =
			mode === "publish"
				? "Simulated only · every 10 minutes · max 3 checks"
				: `Not executed · ${mode === "dry" ? "dry-run" : "local-only"} preview`;
		inspect(state.node);
		element("copy-status").textContent = "";
		renderStage();
	}

	function drawConnections() {
		const grid = element("map-grid").getBoundingClientRect();
		const mobile = window.matchMedia("(max-width: 600px)").matches;
		const connections = mobile
			? [
					["controller", "jev"],
					["jev", "preparation"],
					["preparation", "workers"],
					["workers", "reviewer"],
					["reviewer", "workers"],
					["reviewer", "publication"],
					["publication", "followup"],
				]
			: [
					["api", "controller"],
					["controller", "jev"],
					["jev", "preparation"],
					["preparation", "workers"],
					["workers", "reviewer"],
					["reviewer", "workers"],
					["reviewer", "publication"],
					["publication", "followup"],
					["state", "preparation"],
					["controller", "analysts"],
				];
		element("connection-paths").replaceChildren(
			...connections.map(([from, to]) => {
				const start = element(`node-${from}`).getBoundingClientRect();
				const end = element(`node-${to}`).getBoundingClientRect();
				const vertical = Math.abs(start.left - end.left) < 10;
				const startX = (vertical ? start.left + start.width / 2 : start.right) - grid.left;
				const startY = (vertical ? start.bottom : start.top + start.height / 2) - grid.top;
				const endX = (vertical ? end.left + end.width / 2 : end.left) - grid.left;
				const endY = (vertical ? end.top : end.top + end.height / 2) - grid.top;
				const middle = (startX + endX) / 2;
				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				path.dataset.edge = `${from}:${to}`;
				path.setAttribute(
					"d",
					vertical
						? `M ${startX} ${startY} L ${endX} ${endY - 4}`
						: `M ${startX} ${startY} H ${middle} V ${endY} H ${endX - 4}`,
				);
				path.setAttribute(
					"class",
					`wire${to === stages[state.stage].node || (to === "analysts" && state.stage === 1) ? " active" : ""}`,
				);
				path.setAttribute("marker-end", "url(#arrow)");
				if (from === "reviewer" && to === "workers") {
					const loopX = start.left - grid.left - 10;
					path.setAttribute(
						"d",
						`M ${start.left - grid.left} ${start.top - grid.top + start.height / 2} H ${loopX} V ${end.top - grid.top + end.height / 2} H ${end.left - grid.left - 4}`,
					);
				}
				return path;
			}),
		);
	}

	function selectTab(tab) {
		for (const button of document.querySelectorAll('[role="tab"]')) {
			const active = button === tab;
			button.setAttribute("aria-selected", String(active));
			button.tabIndex = active ? 0 : -1;
			element(button.getAttribute("aria-controls")).hidden = !active;
		}
	}

	for (const button of document.querySelectorAll("[data-node]"))
		button.addEventListener("click", () => {
			stop();
			inspect(button.dataset.node);
		});
	for (const button of document.querySelectorAll("[data-mode]"))
		button.addEventListener("click", () => setMode(button.dataset.mode));
	for (const button of document.querySelectorAll('[role="tab"]')) {
		button.addEventListener("click", () => selectTab(button));
		button.addEventListener("keydown", (event) => {
			if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
				event.preventDefault();
				const target = element(
					event.key === "Home"
						? "tab-replay"
						: event.key === "End"
							? "tab-recorded"
							: button.id === "tab-replay"
								? "tab-recorded"
								: "tab-replay",
				);
				selectTab(target);
				target.focus();
			}
		});
	}
	for (const [id, offset] of [
		["previous", -1],
		["next", 1],
	])
		element(id).addEventListener("click", () => {
			stop();
			setStage(state.stage + offset);
		});
	element("reset").addEventListener("click", () => {
		stop();
		setStage(0);
	});
	element("play").addEventListener("click", () => {
		if (state.timer) {
			stop();
			return;
		}
		if (state.stage === stages.length - 1) setStage(0);
		element("play").setAttribute("aria-label", "Pause walkthrough");
		element("play").textContent = "Ⅱ Pause";
		document.body.classList.add("playing");
		state.timer = setInterval(() => {
			setStage(state.stage + 1);
			if (state.stage === stages.length - 1) stop();
		}, 1800);
	});
	element("copy-command").addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(modes[state.mode].command);
			element("copy-status").textContent = "Copied — not executed";
		} catch {
			const range = document.createRange();
			range.selectNodeContents(element("command"));
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
			element("copy-status").textContent = "Select / copy manually";
		}
	});
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) stop();
	});
	new ResizeObserver(drawConnections).observe(element("map-grid"));
	inspect(state.node);
	setMode(state.mode);
})();
