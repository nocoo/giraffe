import { Button, Checkbox, Field, Input } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { Ban, Clock3, KeyRound, ListChecks, ShieldCheck, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatPreciseDate } from "../lib/format";
import type { PublicAccount } from "../viewmodels/accounts";
import {
	type ApiTokenRow,
	createToken,
	listTokens,
	revokeToken,
	TOKEN_SCOPES,
	tokenScopesLabel,
	updateToken,
} from "../viewmodels/api-tokens";
import { CandyBadge } from "./layout/candy-badge";
import { IconLabel } from "./layout/icon-label";
import { SelectField } from "./layout/select-field";

export function ApiTokens({ accounts }: { accounts: PublicAccount[] }) {
	const [account, setAccount] = useState("");
	const selected = account || accounts.find((a) => a.is_active)?.id || accounts[0]?.id || "";
	const [rows, setRows] = useState<ApiTokenRow[] | null>(null);
	const [label, setLabel] = useState("External Bot");
	const [scopes, setScopes] = useState<string[]>([
		"observations:read",
		"agent:read",
		"agent:write",
	]);
	const [days, setDays] = useState("30");
	const [secret, setSecret] = useState("");
	const [error, setError] = useState("");
	const [listError, setListError] = useState("");
	const [busy, setBusy] = useState(false);
	const listRequest = useRef(0);
	useEffect(() => {
		let cancelled = false;
		const request = ++listRequest.current;
		setSecret("");
		setError("");
		setListError("");
		setRows(selected ? null : []);
		if (selected)
			void listTokens(selected)
				.then((value) => {
					if (!cancelled && request === listRequest.current) setRows(value.items);
				})
				.catch(() => {
					if (!cancelled && request === listRequest.current) setListError("无法读取 API 令牌");
				});
		return () => {
			cancelled = true;
		};
	}, [selected]);
	async function perform(action: () => Promise<void>) {
		setBusy(true);
		setError("");
		try {
			await action();
			listRequest.current++;
			setRows((await listTokens(selected)).items);
			setListError("");
		} catch {
			setError("操作失败，请检查权限、标签和有效期后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<SectionRule
			title={
				<IconLabel
					icon={KeyRound}
					hint="令牌仅绑定所选账号。原文只在创建时显示一次，撤销立即生效。过期或撤销后无法继续调用。不要提交模型密钥或 GitHub PAT。"
					hintLabel="外部 Bot API 令牌说明"
				>
					外部 Bot API 令牌
				</IconLabel>
			}
			actions={
				accounts.length ? (
					<SelectField
						label="令牌账号"
						value={selected}
						onValueChange={setAccount}
						options={accounts.map((a) => ({ value: a.id, label: a.login }))}
						className="w-auto max-w-full"
					/>
				) : null
			}
		>
			<div className="grid min-w-0 gap-basalt-layout xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
				<LayerCard className="min-w-0">
					<LayerCard.Header>
						<span className="flex min-w-0 items-center gap-2 text-basalt-sm font-medium">
							<KeyRound
								className="size-basalt-icon shrink-0"
								strokeWidth={1.5}
								aria-hidden="true"
							/>
							创建令牌
						</span>
					</LayerCard.Header>
					<LayerCard.Body>
						<form
							className="flex flex-col gap-basalt-layout"
							onSubmit={(event) => {
								event.preventDefault();
								void perform(async () => {
									const value = await createToken(selected, label, scopes, Number(days));
									setSecret(value.token);
								});
							}}
						>
							<div className="grid gap-basalt-layout sm:grid-cols-[minmax(0,14rem)_auto] sm:items-end">
								<Field label="标签" htmlFor="new-token-label" className="min-w-0">
									<Input
										id="new-token-label"
										value={label}
										maxLength={80}
										onChange={(event) => setLabel(event.target.value)}
									/>
								</Field>
								<SelectField
									label="有效期"
									value={days}
									onValueChange={setDays}
									options={[1, 7, 30, 90].map((d) => ({ value: String(d), label: `${d} 天` }))}
									className="justify-self-start"
								/>
							</div>
							<Checkbox.Group value={scopes} onValueChange={setScopes} className="min-w-0">
								<Checkbox.Legend className="flex items-center gap-2">
									<ShieldCheck
										className="size-basalt-icon shrink-0"
										strokeWidth={1.5}
										aria-hidden="true"
									/>
									权限
								</Checkbox.Legend>
								<div className="grid gap-basalt-space-lg sm:grid-cols-2">
									{TOKEN_SCOPES.map((scope) => (
										<Checkbox.Item
											key={scope}
											id={`new-token-${scope}`}
											value={scope}
											className="text-basalt-xs"
										>
											{tokenScopesLabel[scope]}
										</Checkbox.Item>
									))}
								</div>
							</Checkbox.Group>
							<div className="flex flex-wrap items-center gap-basalt-space-lg">
								<Button
									type="submit"
									disabled={busy || !selected || !scopes.length || !label.trim()}
								>
									创建令牌
								</Button>
								<p className="text-basalt-xs text-basalt-muted-foreground">
									原文只显示一次，请立即保存；撤销立即生效。
								</p>
							</div>
						</form>
						{secret ? (
							<div className="mt-basalt-layout rounded-basalt-md bg-basalt-control p-basalt-space-lg">
								<p className="text-basalt-sm font-medium">请立即复制保存，关闭后无法再次查看。</p>
								<Input
									className="mt-basalt-space-md font-mono text-basalt-xs"
									aria-label="新 API 令牌（仅显示一次）"
									readOnly
									value={secret}
								/>
								<Button
									className="mt-basalt-space-md"
									size="sm"
									variant="secondary"
									onClick={() => setSecret("")}
								>
									已保存，隐藏令牌
								</Button>
							</div>
						) : null}
						{error ? (
							<p role="alert" className="mt-basalt-layout text-basalt-sm">
								{error}
							</p>
						) : null}
					</LayerCard.Body>
				</LayerCard>
				<LayerCard className="min-w-0">
					<LayerCard.Header>
						<span className="flex min-w-0 items-center gap-2 text-basalt-sm font-medium">
							<ListChecks
								className="size-basalt-icon shrink-0"
								strokeWidth={1.5}
								aria-hidden="true"
							/>
							管理现有令牌
						</span>
						<span className="text-basalt-xs tabular-nums text-basalt-muted-foreground">
							{listError ? "读取失败" : rows === null ? "读取中" : `共 ${rows.length} 个`}
						</span>
					</LayerCard.Header>
					<LayerCard.Body className="min-w-0">
						{listError ? (
							<p role="alert" className="text-basalt-sm">
								{listError}
							</p>
						) : rows === null ? (
							<p role="status" className="text-basalt-sm text-basalt-muted-foreground">
								加载 API 令牌…
							</p>
						) : rows.length === 0 ? (
							<LayerCard.Empty
								icon={<ListChecks />}
								title="还没有 API 令牌"
								description="在左侧创建后，可在这里调整标签、缩小权限或撤销。"
							/>
						) : (
							<ul className="divide-y divide-basalt-border">
								{rows.map((row) => (
									<TokenRow
										key={row.id}
										row={row}
										busy={busy}
										onSave={(label, scopes) =>
											perform(async () => {
												await updateToken(selected, row.id, label, scopes);
											})
										}
										onRevoke={() =>
											perform(async () => {
												await revokeToken(selected, row.id);
											})
										}
									/>
								))}
							</ul>
						)}
					</LayerCard.Body>
				</LayerCard>
			</div>
		</SectionRule>
	);
}

function TokenRow({
	row,
	busy,
	onSave,
	onRevoke,
}: {
	row: ApiTokenRow;
	busy: boolean;
	onSave: (label: string, scopes: string[]) => Promise<void>;
	onRevoke: () => Promise<void>;
}) {
	const [label, setLabel] = useState(row.label);
	const [scopes, setScopes] = useState(row.scopes);
	const revoked = !!row.revoked_at;
	return (
		<li className="flex flex-col gap-basalt-layout-sm py-basalt-layout-sm first:pt-0 last:pb-0">
			<div className="flex flex-wrap items-center gap-basalt-space-lg">
				<Input
					aria-label={`${row.label} 标签`}
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					className="w-full max-w-56"
					disabled={revoked}
				/>
				{revoked ? (
					<CandyBadge tone="gray" icon={Ban}>
						已撤销
					</CandyBadge>
				) : (
					<CandyBadge tone="green" icon={Clock3}>
						到期 {formatPreciseDate(row.expires_at)}
					</CandyBadge>
				)}
				<div className="ml-auto flex flex-wrap items-center gap-basalt-space-md">
					<Button
						size="sm"
						variant="secondary"
						disabled={busy || revoked || !scopes.length}
						onClick={() => void onSave(label, scopes)}
					>
						保存标签与权限
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || revoked}
						onClick={() => void onRevoke()}
					>
						撤销令牌
					</Button>
				</div>
			</div>
			<Checkbox.Group value={scopes} onValueChange={setScopes} disabled={revoked}>
				{row.scopes.map((scope) => (
					<Checkbox.Item
						className="text-basalt-xs"
						key={scope}
						id={`${row.id}-${scope}`}
						value={scope}
					>
						{tokenScopesLabel[scope]}
					</Checkbox.Item>
				))}
			</Checkbox.Group>
			<div className="flex flex-wrap items-center gap-x-basalt-layout gap-y-basalt-space-sm text-basalt-xs text-basalt-muted-foreground">
				<IconLabel icon={UserRound} iconClassName="size-3.5">
					创建者 {row.creator}
				</IconLabel>
				<IconLabel icon={Clock3} iconClassName="size-3.5">
					最近写入 {formatPreciseDate(row.last_used_at)}
				</IconLabel>
				<IconLabel icon={ShieldCheck} iconClassName="size-3.5">
					只能缩小权限，新增权限请创建新令牌
				</IconLabel>
			</div>
		</li>
	);
}
