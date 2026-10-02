import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { GiraffeClient } from "./client.ts";
import { homeDirectory, readConfig, readCredential } from "./config.ts";
import { decisionClient } from "./decision.ts";
import { digest } from "./evidence.ts";
import { acquireInstance } from "./instance.ts";
import { login } from "./login.ts";
import { configuredModels } from "./models.ts";
import { openRuntime } from "./runtime.ts";
import { createWatcher, parseAnalysisTarget, reportInput } from "./watch.ts";

async function main() {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			once: { type: "boolean" },
			domain: { type: "string" },
		},
	});
	const command = positionals[0] ?? "help";
	if (values.help || command === "help") {
		console.log(
			"giraffe login   在网页中授权本机\ngiraffe status  检查账户与模型配置\ngiraffe watch [--once]  观察已采集数据并更新分析\ngiraffe analyze <owner/repo|all> [--domain issues|prs|ci|cd]\n配置：~/.config/giraffe/config.json",
		);
		return;
	}
	const config = readConfig();
	if (command === "login") {
		const result = await login(config.service.baseUrl, { log: console.log });
		console.log(`授权成功：${result.accountId}；有效期至 ${result.expiresAt}`);
	} else if (command === "status") {
		const account = await new GiraffeClient(readCredential()).me();
		console.log(
			`账户：${account.login}\n主控：${config.roles.orchestrator.model}\n决策：${config.roles.decision.model}\n执行：${config.roles.executor.model}`,
		);
	} else if (command === "watch" || command === "analyze") {
		const credential = readCredential();
		if (new URL(credential.baseUrl).origin !== new URL(config.service.baseUrl).origin)
			throw new Error("Service changed; run giraffe login again.");
		const client = new GiraffeClient(credential);
		const identity = await client.me();
		const key = digest({
			service: credential.baseUrl,
			account: credential.account_id,
		}).slice(0, 24);
		const directory = join(homeDirectory(), "state");
		const release = acquireInstance(directory, key);
		const controller = new AbortController();
		let runtime: Awaited<ReturnType<typeof openRuntime>> | undefined;
		const stop = () => {
			controller.abort();
			void runtime?.close();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		try {
			runtime = await openRuntime({
				storage: await openNodeSqliteStorage(join(directory, `${key}.sqlite`)),
				config,
				models: configuredModels(config),
				decide: decisionClient(config),
				log: console.log,
				publish: async (id, report, signal) => {
					await client.create("reports", reportInput(id, report), signal);
				},
			});
			const watcher = createWatcher({
				client,
				runtime,
				config,
				version: (
					JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
						version: string;
					}
				).version,
				log: console.log,
			});
			console.log(
				`giraffe | ${identity.login}\n主控 ${config.roles.orchestrator.model} → 决策 ${config.roles.decision.model} → 执行 ${config.roles.executor.model}`,
			);
			if (command === "analyze")
				await watcher.once(parseAnalysisTarget(positionals[1], values.domain));
			else if (values.once) await watcher.once();
			else await watcher.watch(controller.signal);
		} finally {
			await runtime?.close();
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			release();
		}
	} else throw new Error("未知命令，请运行 giraffe --help。");
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : "执行失败。");
	process.exitCode = 1;
});
