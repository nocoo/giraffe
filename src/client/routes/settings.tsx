import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
	Button,
	ConfirmDialog,
	Field,
	toast,
} from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { SensitiveInput } from "@nocoo/basalt/components/sensitive-input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { type FormEvent, useEffect, useState } from "react";
import { PageToolbar } from "../components/layout/page-toolbar";
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, reportError, reportOk } from "../lib/error-ui";
import { initials } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	type AccountAddPhase,
	accountAddBusy,
	accountAddHint,
	accountAddLabel,
	accountFieldError,
	activateAccount,
	canSubmitAccount,
	createAccount,
	deleteAccount,
	emptyToken,
	loadAccounts,
	type PublicAccount,
} from "../viewmodels/accounts";
import { displayName, loadMe, type MeIdentity } from "../viewmodels/me";
import { requestRefresh } from "../viewmodels/refresh";

export function SettingsPage() {
	const [token, setToken] = useState("");
	const [accounts, setAccounts] = useState<PublicAccount[]>([]);
	const [me, setMe] = useState<MeIdentity | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [phase, setPhase] = useState<AccountAddPhase>("idle");
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [actingId, setActingId] = useState<string | null>(null);
	const busy = accountAddBusy(phase);

	function onLoadError(err: unknown): void {
		catchLoad(err, (message) => {
			toast.error(message);
		});
	}

	function reload() {
		return Promise.all([loadMe(), loadAccounts()]).then(([identity, rows]) => {
			setMe(identity);
			setAccounts(rows);
			if (rows.some((row) => row.is_active)) {
				reportOk();
			}
		});
	}

	useEffect(() => {
		void Promise.all([loadMe(), loadAccounts()])
			.then(([identity, rows]) => {
				setMe(identity);
				setAccounts(rows);
				if (rows.some((row) => row.is_active)) {
					reportOk();
				}
			})
			.catch((err: unknown) => {
				catchLoad(err, (message) => {
					toast.error(message);
				});
			});
	}, []);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (!canSubmitAccount(token, phase)) {
			return;
		}
		const value = token;
		setToken(emptyToken());
		setError(null);
		setPhase("saving");
		try {
			await createAccount(value, (next) => {
				setPhase(next);
			});
			await reload();
			toast.success("已添加账号");
		} catch (err) {
			reportError(err);
			setError(accountFieldError(err) ?? "添加失败");
		} finally {
			setPhase("idle");
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<PageToolbar
				title="设置"
				description={PAGE_DESCRIPTIONS["/settings"]}
				actions={
					<RefreshButton
						run={() =>
							requestRefresh("all").then(() => {
								return reload();
							})
						}
						onError={onLoadError}
					/>
				}
			/>
			<LayerCard>
				<LayerCard.Secondary>Access 身份</LayerCard.Secondary>
				<LayerCard.Body>
					{me ? (
						<div className="flex items-center gap-3">
							<Avatar className="h-10 w-10">
								{me.avatar ? <AvatarImage src={me.avatar} alt={displayName(me)} /> : null}
								<AvatarFallback>{initials(displayName(me))}</AvatarFallback>
							</Avatar>
							<div className="min-w-0">
								<p className="truncate font-medium">{displayName(me)}</p>
								<p className="truncate text-sm text-basalt-muted-foreground">{me.email}</p>
							</div>
						</div>
					) : (
						<p className="text-sm text-basalt-muted-foreground">加载身份…</p>
					)}
				</LayerCard.Body>
			</LayerCard>
			<LayerCard>
				<LayerCard.Secondary>GitHub 账号</LayerCard.Secondary>
				<LayerCard.Body>
					<form
						className="flex max-w-xl flex-col gap-3"
						aria-busy={busy}
						onSubmit={(event) => void onSubmit(event)}
					>
						<Field
							label="GitHub classic PAT"
							htmlFor="pat"
							hint={accountAddHint(phase) ?? "需要 repo、read:org、read:user、notifications"}
							{...(error ? { error } : {})}
						>
							<SensitiveInput
								id="pat"
								name="token"
								autoComplete="off"
								revealLabel="显示令牌"
								hideLabel="隐藏令牌"
								value={token}
								disabled={busy}
								onChange={(event) => setToken(event.target.value)}
								data-testid="pat-input"
								passwordManagerIgnore
							/>
						</Field>
						<div>
							<Button
								type="submit"
								data-testid="pat-submit"
								loading={busy}
								disabled={!canSubmitAccount(token, phase)}
							>
								{accountAddLabel(phase)}
							</Button>
						</div>
					</form>
				</LayerCard.Body>
			</LayerCard>
			<LayerCard>
				<LayerCard.Header>
					<p className="font-medium text-basalt-foreground">账号</p>
				</LayerCard.Header>
				<LayerCard.Primary className="p-0">
					{accounts.length === 0 ? (
						<LayerCard.Empty title="还没有 GitHub 账号" description="在上方粘贴 classic PAT。" />
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>账号</TableHead>
									<TableHead>末四位</TableHead>
									<TableHead>scopes</TableHead>
									<TableHead>状态</TableHead>
									<TableHead>操作</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{accounts.map((row) => (
									<TableRow key={row.id}>
										<TableCell>
											<div className="flex items-center gap-2">
												<Avatar>
													<AvatarImage src={row.avatar_url} alt={row.login} />
													<AvatarFallback>{row.login.slice(0, 2)}</AvatarFallback>
												</Avatar>
												{row.login}
											</div>
										</TableCell>
										<TableCell className="font-mono text-sm">{row.token_last4}</TableCell>
										<TableCell className="text-sm text-basalt-muted-foreground">
											{row.scopes}
										</TableCell>
										<TableCell>
											{row.is_active ? (
												<Badge variant="success">当前</Badge>
											) : (
												<Badge variant="outline">待命</Badge>
											)}
										</TableCell>
										<TableCell>
											<div className="flex gap-2">
												<Button
													type="button"
													variant="secondary"
													disabled={row.is_active || actingId === row.id}
													loading={actingId === row.id}
													onClick={() => {
														setActingId(row.id);
														void activateAccount(row.id)
															.then(() => {
																toast.success("已激活");
																return reload();
															})
															.catch(onLoadError)
															.finally(() => {
																setActingId(null);
															});
													}}
												>
													激活
												</Button>
												<Button
													type="button"
													variant="destructive"
													onClick={() => setPendingId(row.id)}
												>
													删除
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</LayerCard.Primary>
			</LayerCard>
			<ConfirmDialog
				open={pendingId !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingId(null);
					}
				}}
				title="删除账号"
				description="将删除该账号及其快照。"
				confirmLabel="删除"
				cancelLabel="取消"
				variant="destructive"
				onConfirm={() => {
					if (!pendingId) {
						return;
					}
					return deleteAccount(pendingId)
						.then(() => {
							toast.success("已删除");
							setPendingId(null);
							return reload();
						})
						.catch(onLoadError);
				}}
			/>
		</div>
	);
}
