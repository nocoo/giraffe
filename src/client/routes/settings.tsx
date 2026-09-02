import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
	Button,
	ConfirmDialog,
	Field,
	LayerCard,
	toast,
} from "@nocoo/basalt";
import { PageHeader } from "@nocoo/basalt/components/page-header";
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
import { RefreshButton } from "../components/layout/refresh-button";
import { catchLoad, reportError, reportOk } from "../lib/error-ui";
import { initials } from "../lib/format";
import { PAGE_DESCRIPTIONS } from "../lib/navigation";
import {
	accountFieldError,
	activateAccount,
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
	const [pendingId, setPendingId] = useState<string | null>(null);

	function onLoadError(err: unknown): void {
		catchLoad(err, toast);
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
				catchLoad(err, toast);
			});
	}, []);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		const value = token;
		setToken(emptyToken());
		setError(null);
		try {
			await createAccount(value);
			await reload();
			toast("已添加账号");
		} catch (err) {
			reportError(err);
			setError(accountFieldError(err) ?? "添加失败");
		}
	}

	return (
		<div className="flex flex-col gap-6">
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
			<LayerCard className="rounded-card bg-secondary">
				<LayerCard.Header>
					<p className="font-medium">Access 身份</p>
				</LayerCard.Header>
				<LayerCard.Body>
					{me ? (
						<div className="flex items-center gap-3">
							<Avatar className="h-10 w-10">
								<AvatarFallback>{initials(displayName(me))}</AvatarFallback>
							</Avatar>
							<div className="min-w-0">
								<p className="truncate font-medium">{displayName(me)}</p>
								<p className="truncate text-sm text-muted-foreground">{me.email}</p>
							</div>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">加载身份…</p>
					)}
				</LayerCard.Body>
			</LayerCard>
			<LayerCard className="rounded-card bg-secondary">
				<LayerCard.Header>
					<p className="font-medium">GitHub 账号</p>
				</LayerCard.Header>
				<LayerCard.Body>
					<form className="flex max-w-xl flex-col gap-3" onSubmit={(event) => void onSubmit(event)}>
						<Field
							label="GitHub classic PAT"
							htmlFor="pat"
							hint="需要 repo、read:org、read:user、notifications"
							{...(error ? { error } : {})}
						>
							<SensitiveInput
								id="pat"
								name="token"
								autoComplete="off"
								revealLabel="显示令牌"
								hideLabel="隐藏令牌"
								value={token}
								onChange={(event) => setToken(event.target.value)}
								data-testid="pat-input"
								passwordManagerIgnore
							/>
						</Field>
						<div>
							<Button type="submit" data-testid="pat-submit">
								添加账号
							</Button>
						</div>
					</form>
				</LayerCard.Body>
			</LayerCard>
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
							<TableCell className="text-sm text-muted-foreground">{row.scopes}</TableCell>
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
										disabled={row.is_active}
										onClick={() => {
											void activateAccount(row.id)
												.then(() => {
													toast("已激活");
													return reload();
												})
												.catch(onLoadError);
										}}
									>
										激活
									</Button>
									<Button type="button" variant="destructive" onClick={() => setPendingId(row.id)}>
										删除
									</Button>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
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
							toast("已删除");
							setPendingId(null);
							return reload();
						})
						.catch(onLoadError);
				}}
			/>
		</div>
	);
}
