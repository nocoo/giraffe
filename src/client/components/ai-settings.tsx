import { Button, Field, Input, Text } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SensitiveInput } from "@nocoo/basalt/components/sensitive-input";
import { BrainCircuit, FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	type AiSettingsDraft,
	defaultAiSettings,
	type PublicAiSettings,
	sameAiDestination,
} from "../../lib/ai-settings";
import {
	aiSettingsError,
	canSubmitAiSettings,
	deleteAiSettings,
	draftAiSettings,
	loadAiSettings,
	saveAiSettings,
	testAiSettings,
} from "../viewmodels/ai-settings";
import { CandyBadge } from "./layout/candy-badge";
import { SelectField } from "./layout/select-field";

function AiSettingsCard({ settings }: { settings: PublicAiSettings }) {
	const [saved, setSaved] = useState(settings);
	const [draft, setDraft] = useState(() => draftAiSettings(settings));
	const [phase, setPhase] = useState<"idle" | "saving" | "testing" | "removing">("idle");
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const summary = settings.kind === "summary";
	const title = summary ? "通用 AI · 仓库报告" : "GEV · 判断与归类";
	const busy = phase !== "idle";
	const canSubmit = canSubmitAiSettings(draft, saved, busy);
	const retainedKey = saved.hasApiKey && sameAiDestination(draft, saved);
	const Icon = summary ? FileText : BrainCircuit;
	const id = `ai-${settings.kind}`;

	function change(values: Partial<AiSettingsDraft>) {
		setDraft((current) => ({ ...current, ...values }));
		setError(null);
		setStatus(null);
	}

	async function submit(action: "saving" | "testing") {
		if (!canSubmit) return;
		const value = draft;
		setDraft((current) => ({ ...current, apiKey: "" }));
		setPhase(action);
		setError(null);
		setStatus(null);
		try {
			if (action === "saving") {
				const next = await saveAiSettings(settings.kind, value);
				setSaved(next);
				setDraft(draftAiSettings(next));
				setStatus("已保存，下次刷新仓库数据时生效。");
			} else {
				await testAiSettings(settings.kind, value);
				setStatus("连接成功。测试不会保存配置。");
			}
		} catch (err) {
			setError(aiSettingsError(err));
		} finally {
			setPhase("idle");
		}
	}

	async function remove() {
		setPhase("removing");
		setDraft((current) => ({ ...current, apiKey: "" }));
		setError(null);
		setStatus(null);
		try {
			await deleteAiSettings(settings.kind);
			const next = defaultAiSettings(settings.kind);
			setSaved(next);
			setDraft(draftAiSettings(next));
			setStatus("已停用并清除保存的 key。");
		} catch (err) {
			setError(aiSettingsError(err));
		} finally {
			setPhase("idle");
		}
	}

	return (
		<LayerCard data-testid={`${id}-card`}>
			<LayerCard.Header>
				<Text as="h2" variant="heading" className="flex items-center gap-2">
					<Icon className="size-4 text-basalt-primary" aria-hidden="true" />
					{title}
				</Text>
				<CandyBadge tone={saved.hasApiKey ? "green" : "gray"}>
					{saved.hasApiKey ? "已配置" : "未配置"}
				</CandyBadge>
			</LayerCard.Header>
			<LayerCard.Body>
				<form
					className="space-y-4"
					aria-label={title}
					aria-busy={busy}
					onSubmit={(event) => {
						event.preventDefault();
						void submit("saving");
					}}
				>
					<p className="text-sm leading-6 text-basalt-muted-foreground">
						{summary
							? "综合提交、PR、Issue、交付节奏与 GEV 判断，生成结构化仓库报告。"
							: "通过 TypeSafe 模型判断安全事项的紧急程度、识别需要人工技术判断的 PR。"}
					</p>
					<fieldset disabled={busy} className="min-w-0 space-y-4">
						{summary ? (
							<>
								<div className="grid gap-4 sm:grid-cols-2">
									<SelectField
										label="API 协议"
										value={draft.sdkType}
										onValueChange={(sdkType) =>
											change({ sdkType: sdkType as AiSettingsDraft["sdkType"] })
										}
										options={[
											{ value: "openai", label: "OpenAI" },
											{ value: "anthropic", label: "Anthropic" },
										]}
									/>
									<SelectField
										label="认证方式"
										value={draft.authType}
										onValueChange={(authType) =>
											change({ authType: authType as AiSettingsDraft["authType"] })
										}
										options={[
											{ value: "apiKey", label: "API key" },
											{ value: "bearer", label: "Bearer token" },
										]}
									/>
								</div>
								<Field
									label="API 地址"
									htmlFor={`${id}-url`}
									hint="填写服务的 HTTPS API 地址；OpenAI 标准通常包含 /v1。"
								>
									<Input
										id={`${id}-url`}
										value={draft.baseURL}
										onChange={(event) => change({ baseURL: event.target.value })}
										placeholder="https://api.openai.com/v1"
										autoComplete="off"
										required
									/>
								</Field>
							</>
						) : null}
						<Field label="模型" htmlFor={`${id}-model`}>
							<Input
								id={`${id}-model`}
								value={draft.model}
								onChange={(event) => change({ model: event.target.value })}
								placeholder={summary ? "服务商提供的模型名称" : "jev-latest"}
								autoComplete="off"
								required
								maxLength={160}
							/>
						</Field>
						<Field
							label="API key"
							htmlFor={`${id}-key`}
							hint={
								retainedKey
									? "已加密保存；留空继续使用现有 key。"
									: "输入该服务的 API key，提交后输入框会清空。"
							}
						>
							<SensitiveInput
								id={`${id}-key`}
								value={draft.apiKey}
								onChange={(event) => change({ apiKey: event.target.value })}
								placeholder={retainedKey ? "留空保留已保存的 key" : "输入 API key"}
								autoComplete="off"
								passwordManagerIgnore
								revealLabel="显示 API key"
								hideLabel="隐藏 API key"
							/>
						</Field>
					</fieldset>
					<div className="flex flex-wrap items-center gap-2">
						<Button type="submit" disabled={!canSubmit} loading={phase === "saving"}>
							保存配置
						</Button>
						<Button
							type="button"
							data-testid={`${id}-test`}
							variant="secondary"
							disabled={!canSubmit}
							loading={phase === "testing"}
							onClick={() => void submit("testing")}
						>
							测试连接
						</Button>
						{saved.hasApiKey ? (
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								loading={phase === "removing"}
								data-testid={`${id}-remove`}
								onClick={() => void remove()}
							>
								停用并清除 key
							</Button>
						) : null}
					</div>
					{error ? (
						<p className="text-sm text-basalt-destructive" role="alert">
							{error}
						</p>
					) : null}
					{status ? (
						<p className="text-sm text-basalt-muted-foreground" role="status">
							{status}
						</p>
					) : null}
				</form>
			</LayerCard.Body>
		</LayerCard>
	);
}

export function AiSettings() {
	const [settings, setSettings] = useState<PublicAiSettings[] | null>(null);
	const [error, setError] = useState(false);
	const reload = useCallback(async () => {
		setError(false);
		try {
			setSettings(await loadAiSettings());
		} catch {
			setError(true);
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);
	return (
		<SectionRule title="AI 评估">
			<p className="mb-4 text-sm text-basalt-muted-foreground">
				两项配置保存后，下次仓库刷新会将统计、事项标题与正文节选发送到对应 AI 服务进行评估。
			</p>
			{settings ? (
				<div className="grid items-start gap-4 xl:grid-cols-2">
					{settings.map((item) => (
						<AiSettingsCard key={item.kind} settings={item} />
					))}
				</div>
			) : error ? (
				<div className="flex items-center gap-3">
					<p className="text-sm text-basalt-muted-foreground" role="alert">
						AI 配置加载失败。
					</p>
					<Button variant="secondary" size="sm" onClick={() => void reload()}>
						重试
					</Button>
				</div>
			) : (
				<p className="text-sm text-basalt-muted-foreground" role="status">
					加载 AI 配置…
				</p>
			)}
		</SectionRule>
	);
}
