import { Button } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { SelectField } from "../components/layout/select-field";
import { loadAccounts, type PublicAccount } from "../viewmodels/accounts";
import { authorizeAgent, loginRequest, tokenScopesLabel } from "../viewmodels/api-tokens";
import { loadMe } from "../viewmodels/me";
export function AuthorizePage() {
	const location = useLocation();
	const request = loginRequest(location.search);
	const [accounts, setAccounts] = useState<PublicAccount[]>([]);
	const [account, setAccount] = useState("");
	const [identity, setIdentity] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void Promise.all([loadAccounts(), loadMe()])
			.then(([rows, me]) => {
				setAccounts(rows);
				setAccount(rows.find((r) => r.is_active)?.id ?? rows[0]?.id ?? "");
				setIdentity(me.email);
			})
			.catch(() => setError("请先通过 Access 登录并连接 GitHub 账号。"));
	}, []);
	return (
		<div className="mx-auto max-w-xl space-y-4">
			<PageHeader title="授权本地 Agent" description="仅在你刚刚从本机 CLI 发起登录时继续" />
			<LayerCard>
				<LayerCard.Body className="space-y-4">
					{request ? (
						<>
							<p className="text-sm">已登录：{identity || "正在验证身份…"}</p>
							<SelectField
								label="授权账号"
								value={account}
								onValueChange={setAccount}
								options={accounts.map((a) => ({ value: a.id, label: a.login }))}
							/>
							<p className="text-sm">
								回调地址：<code>{request.redirect_uri}</code>
							</p>
							<ul className="space-y-1 text-sm">
								{request.scopes.map((s) => (
									<li key={s}>{tokenScopesLabel[s]}</li>
								))}
							</ul>
							<p className="text-xs text-basalt-muted-foreground">
								有效期 30 天，可在设置中撤销。回调只发送一次性授权码，不发送长期令牌。
							</p>
							<div className="flex gap-3">
								<Button
									disabled={busy || !identity || !account}
									onClick={() => {
										setBusy(true);
										setError("");
										void authorizeAgent(request, account, "Local Agent")
											.then((value) => window.location.assign(value.redirect_uri))
											.catch(() => {
												setBusy(false);
												setError("授权失败，请重新从 CLI 发起登录。");
											});
									}}
								>
									同意并返回 CLI
								</Button>
								<Button
									variant="secondary"
									disabled={busy}
									onClick={() => window.location.assign("/settings")}
								>
									取消
								</Button>
							</div>
						</>
					) : (
						<p role="alert">授权参数无效。仅支持带 PKCE 的本机回调，请重新从 CLI 发起登录。</p>
					)}
					{error ? <p role="alert">{error}</p> : null}
				</LayerCard.Body>
			</LayerCard>
		</div>
	);
}
