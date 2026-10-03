import { join } from "node:path";
import { parseArgs } from "node:util";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GiraffeClient } from "./client.ts";
import { homeDirectory, readConfig, readCredential } from "./config.ts";
import { digest } from "./evidence.ts";
import { acquireInstance } from "./instance.ts";
import { login } from "./login.ts";
import { configuredModels } from "./models.ts";
import { openRuntime } from "./runtime.ts";
import { workDaemon } from "./work-daemon.ts";

async function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			once: { type: "boolean" },
			"dry-run": { type: "boolean" },
			"no-push": { type: "boolean" },
			limit: { type: "string" },
			repos: { type: "string" },
		},
	});
	const command = positionals[0] ?? "help";
	if (values.help || command === "help") {
		console.log(
			"giraffe login  在网页授权本机\ngiraffe status  检查账户和角色\ngiraffe work [--once] [--dry-run] [--no-push] [--limit 5] [--repos owner/repo,...]\n单一 cron 持续工作；--once 单次；--dry-run 无写入；--no-push 仅本地提交。\n配置：~/.config/giraffe/config.json",
		);
		return;
	}
	if (!["login", "status", "work"].includes(command))
		throw new Error("未知命令，请运行 giraffe --help。");
	const config = readConfig();
	if (command === "login") {
		const result = await login(config.service.baseUrl, { log: console.log });
		console.log(`授权成功：${result.accountId}；有效期至 ${result.expiresAt}`);
		return;
	}
	const credential = readCredential();
	const client = new GiraffeClient(credential);
	const identity = await client.me();
	console.log(
		`giraffe | ${identity.login}\n主控 ${config.roles.orchestrator.model} → 决策 ${config.roles.decision.model} → 执行 ${config.roles.executor.model}`,
	);
	if (command === "status") return;
	const limit = Number(values.limit ?? "5");
	if (!Number.isInteger(limit) || limit < 1 || limit > 25)
		throw new Error("Work limit must be 1–25.");
	if (new URL(credential.baseUrl).origin !== new URL(config.service.baseUrl).origin)
		throw new Error("Service changed; run giraffe login again.");
	const key = digest({ service: credential.baseUrl, account: credential.account_id }).slice(0, 24);
	const directory = join(homeDirectory(), "state");
	const release = acquireInstance(directory, key);
	const controller = new AbortController();
	const stop = () => {
		controller.abort();
		void runtime?.close();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
	try {
		runtime = await openRuntime({
			storage: values["dry-run"]
				? new MemoryStorage()
				: await openNodeSqliteStorage(join(directory, `${key}-work.sqlite`)),
			models: configuredModels(config),
		});
		const daemon = await workDaemon({
			runtime,
			client,
			config,
			log: console.log,
			dryRun: values["dry-run"] ?? false,
			push: !values["no-push"],
			limit,
			once: values.once || values["dry-run"] || false,
			...(values.repos ? { repositories: values.repos.split(",") } : {}),
		});
		try {
			if (values.once || values["dry-run"]) await daemon.tick(controller.signal, true);
			else await daemon.serve(controller.signal);
		} finally {
			await daemon.close();
		}
	} finally {
		await runtime?.close();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		release();
	}
}
main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "执行失败。");
	process.exitCode = 1;
});
