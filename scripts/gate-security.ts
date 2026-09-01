export {};

async function runCommand(cmd: string[], label: string): Promise<boolean> {
	try {
		const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			console.error(`\n${label} FAILED (exit ${exitCode}):`);
			if (stdout) process.stdout.write(stdout);
			if (stderr) process.stderr.write(stderr);
			return false;
		}
		console.log(`${label}: passed`);
		return true;
	} catch {
		console.error(`${label}: tool not installed.`);
		return false;
	}
}

const arg = process.argv[2];
const tasks: Array<() => Promise<boolean>> = [];
if (arg !== "--deps") {
	const ranges = (process.env.GITLEAKS_LOG_OPTS ?? "origin/main..HEAD").trim().split(/\s+/);
	for (const range of ranges) {
		tasks.push(() =>
			runCommand(
				["gitleaks", "detect", "--no-banner", "--redact", `--log-opts=${range}`],
				`gitleaks ${range}`,
			),
		);
	}
}
if (arg !== "--secrets") {
	tasks.push(() => runCommand(["osv-scanner", "--lockfile=bun.lock"], "osv-scanner"));
}

const results = await Promise.all(tasks.map((task) => task()));
if (!results.every(Boolean)) {
	process.exit(1);
}
console.log("gate:security passed");
