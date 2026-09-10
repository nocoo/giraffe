import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	ConfirmDialog,
	Field,
	Link,
	toast,
} from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SensitiveInput } from "@nocoo/basalt/components/sensitive-input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@nocoo/basalt/components/table";
import { ExternalLink, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { CandyBadge } from "../components/layout/candy-badge";
import { ResultCount, TableScroll } from "../components/layout/collection-chrome";
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
		<div className="space-y-8">
			<PageHeader
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
			<SectionRule title="账号连接">
				<div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
					<LayerCard>
						<LayerCard.Header>
							<div className="flex items-center gap-2 text-sm font-medium text-basalt-foreground">
								<KeyRound className="size-4 text-basalt-primary" aria-hidden="true" />
								连接 GitHub
							</div>
							<Link
								href="https://github.com/settings/tokens/new"
								target="_blank"
								rel="noreferrer"
								className="inline-flex shrink-0 items-center gap-1 text-xs"
							>
								创建 classic PAT
								<ExternalLink className="size-3" aria-hidden="true" />
							</Link>
						</LayerCard.Header>
						<LayerCard.Body>
							<form
								className="flex flex-col gap-4"
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
										placeholder="粘贴 GitHub classic PAT"
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
								<p className="text-xs leading-5 text-basalt-muted-foreground">
									首个账号添加成功后会自动同步仓库。
								</p>
							</form>
						</LayerCard.Body>
					</LayerCard>
					<LayerCard>
						<LayerCard.Header>
							<div className="flex items-center gap-2 text-sm font-medium text-basalt-foreground">
								<ShieldCheck className="size-4 text-basalt-primary" aria-hidden="true" />
								访问身份
							</div>
						</LayerCard.Header>
						<LayerCard.Body className="space-y-5">
							{me ? (
								<div className="flex items-center gap-3">
									<Avatar className="size-10 shrink-0">
										{me.avatar ? <AvatarImage src={me.avatar} alt={displayName(me)} /> : null}
										<AvatarFallback>{initials(displayName(me))}</AvatarFallback>
									</Avatar>
									<div className="min-w-0">
										<p className="truncate font-medium">{displayName(me)}</p>
										<p className="truncate text-sm text-basalt-muted-foreground">{me.email}</p>
									</div>
								</div>
							) : (
								<p className="text-sm text-basalt-muted-foreground" role="status">
									加载身份…
								</p>
							)}
							<div className="space-y-2 text-xs leading-6 text-basalt-muted-foreground">
								<p>访问身份由 Cloudflare Access 验证。</p>
								<p>每次使用一个活跃的 GitHub 账号。切换账号后，页面会显示该账号的数据。</p>
							</div>
						</LayerCard.Body>
					</LayerCard>
				</div>
			</SectionRule>
			<SectionRule title="已连接的账号" actions={<ResultCount count={accounts.length} />}>
				<LayerCard>
					<LayerCard.Well className="p-0">
						{accounts.length === 0 ? (
							<LayerCard.Empty title="还没有 GitHub 账号" description="在上方粘贴 classic PAT。" />
						) : (
							<TableScroll label="GitHub 账号列表">
								<Table className="min-w-[680px] [&_th]:whitespace-nowrap">
									<TableHeader>
										<TableRow>
											<TableHead>账号</TableHead>
											<TableHead>令牌</TableHead>
											<TableHead>权限范围</TableHead>
											<TableHead>状态</TableHead>
											<TableHead className="text-right">操作</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{accounts.map((row) => (
											<TableRow key={row.id}>
												<TableCell>
													<div className="flex items-center gap-2">
														<Avatar className="size-8">
															{row.avatar_url ? (
																<AvatarImage src={row.avatar_url} alt={row.login} />
															) : null}
															<AvatarFallback>{initials(row.login)}</AvatarFallback>
														</Avatar>
														{row.login}
													</div>
												</TableCell>
												<TableCell className="whitespace-nowrap font-mono text-xs">
													•••• {row.token_last4}
												</TableCell>
												<TableCell className="max-w-56 text-xs leading-5 text-basalt-muted-foreground">
													{row.scopes}
												</TableCell>
												<TableCell>
													{row.is_active ? (
														<CandyBadge tone="green">当前</CandyBadge>
													) : (
														<CandyBadge tone="gray">待命</CandyBadge>
													)}
												</TableCell>
												<TableCell>
													<div className="flex justify-end gap-2">
														<Button
															size="sm"
															type="button"
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
															size="sm"
															type="button"
															variant="destructive"
															icon={<Trash2 className="size-3.5" aria-hidden="true" />}
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
							</TableScroll>
						)}
					</LayerCard.Well>
				</LayerCard>
			</SectionRule>
			<ConfirmDialog
				open={pendingId !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingId(null);
					}
				}}
				title="删除账号"
				description={`将删除 ${accounts.find((row) => row.id === pendingId)?.login ?? "该账号"} 的账号连接及其快照。此操作不会删除 GitHub 上的仓库。`}
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
