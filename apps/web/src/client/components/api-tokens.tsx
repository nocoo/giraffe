import { Button, Checkbox, Input } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { useEffect, useState } from "react";
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
import { SelectField } from "./layout/select-field";

export function ApiTokens({ accounts }: { accounts: PublicAccount[] }) {
	const [account, setAccount] = useState("");
	const selected = account || accounts.find((a) => a.is_active)?.id || accounts[0]?.id || "";
	const [rows, setRows] = useState<ApiTokenRow[]>([]);
	const [label, setLabel] = useState("Local Agent");
	const [scopes, setScopes] = useState<string[]>([
		"observations:read",
		"agent:read",
		"agent:write",
	]);
	const [days, setDays] = useState("30");
	const [secret, setSecret] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let cancelled = false;
		setSecret("");
		setRows([]);
		if (selected)
			void listTokens(selected)
				.then((value) => {
					if (!cancelled) setRows(value.items);
				})
				.catch(() => {
					if (!cancelled) setError("无法读取 API 令牌");
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
			setRows((await listTokens(selected)).items);
		} catch {
			setError("操作失败，请检查权限、标签和有效期后重试。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<LayerCard>
			<LayerCard.Header>本地 Agent API 令牌</LayerCard.Header>
			<LayerCard.Body className="space-y-4">
				<p className="text-sm text-basalt-muted-foreground">
					令牌仅绑定所选账号。原文只显示一次；撤销立即生效。不要提交模型密钥或 GitHub PAT。
				</p>
				<SelectField
					label="令牌账号"
					value={selected}
					onValueChange={setAccount}
					options={accounts.map((a) => ({ value: a.id, label: a.login }))}
				/>
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						void perform(async () => {
							const value = await createToken(selected, label, scopes, Number(days));
							setSecret(value.token);
						});
					}}
				>
					<div className="flex flex-wrap gap-3">
						<Input
							aria-label="新令牌标签"
							value={label}
							maxLength={80}
							onChange={(event) => setLabel(event.target.value)}
							className="w-56"
						/>
						<SelectField
							label="有效期"
							value={days}
							onValueChange={setDays}
							options={[1, 7, 30, 90].map((d) => ({ value: String(d), label: `${d} 天` }))}
						/>
					</div>
					<div className="flex flex-wrap gap-4">
						{TOKEN_SCOPES.map((scope) => (
							<label
								key={scope}
								htmlFor={`new-token-${scope}`}
								className="flex items-center gap-2 text-sm"
							>
								<Checkbox
									id={`new-token-${scope}`}
									checked={scopes.includes(scope)}
									onCheckedChange={(checked) =>
										setScopes((old) => (checked ? [...old, scope] : old.filter((s) => s !== scope)))
									}
								/>
								{tokenScopesLabel[scope]}
							</label>
						))}
					</div>
					<Button type="submit" disabled={busy || !selected || !scopes.length || !label.trim()}>
						创建令牌
					</Button>
				</form>
				{secret ? (
					<div className="space-y-2">
						<p className="text-sm font-medium">请立即复制保存，关闭后无法再次查看。</p>
						<Input aria-label="新 API 令牌（仅显示一次）" readOnly value={secret} />
						<Button size="sm" variant="secondary" onClick={() => setSecret("")}>
							已保存，隐藏令牌
						</Button>
					</div>
				) : null}
				{error ? <p role="alert">{error}</p> : null}
				<div className="space-y-3">
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
				</div>
			</LayerCard.Body>
		</LayerCard>
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
	return (
		<div className="space-y-2 border-t border-basalt-border pt-3">
			<div className="flex flex-wrap items-center gap-3">
				<Input
					aria-label={`${row.label} 标签`}
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					className="w-56"
					disabled={!!row.revoked_at}
				/>
				<span className="text-xs">
					{row.revoked_at ? "已撤销" : `到期 ${formatPreciseDate(row.expires_at)}`}
				</span>
				<Button
					size="sm"
					variant="secondary"
					disabled={busy || !!row.revoked_at || !scopes.length}
					onClick={() => void onSave(label, scopes)}
				>
					保存标签与权限
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={busy || !!row.revoked_at}
					onClick={() => void onRevoke()}
				>
					撤销令牌
				</Button>
			</div>
			<div className="flex flex-wrap gap-3">
				{row.scopes.map((scope) => (
					<label
						className="flex items-center gap-2 text-xs"
						key={scope}
						htmlFor={`${row.id}-${scope}`}
					>
						<Checkbox
							id={`${row.id}-${scope}`}
							disabled={!!row.revoked_at}
							checked={scopes.includes(scope)}
							onCheckedChange={(checked) =>
								setScopes((old) => (checked ? [...old, scope] : old.filter((s) => s !== scope)))
							}
						/>
						{tokenScopesLabel[scope]}
					</label>
				))}
			</div>
			<p className="text-xs text-basalt-muted-foreground">
				创建者 {row.creator} · 最近写入 {formatPreciseDate(row.last_used_at)} ·
				只能缩小权限，新增权限请创建新令牌
			</p>
		</div>
	);
}
