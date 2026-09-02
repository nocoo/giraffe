import { Button, ConfirmDialog, Field } from "@nocoo/basalt";
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

export function SettingsPage() {
	const [token, setToken] = useState("");
	const [accounts, setAccounts] = useState<PublicAccount[]>([]);
	const [me, setMe] = useState<MeIdentity | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);

	function reload() {
		return Promise.all([loadMe(), loadAccounts()]).then(([identity, rows]) => {
			setMe(identity);
			setAccounts(rows);
		});
	}

	useEffect(() => {
		void Promise.all([loadMe(), loadAccounts()]).then(([identity, rows]) => {
			setMe(identity);
			setAccounts(rows);
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
		} catch (err) {
			setError(accountFieldError(err) ?? "添加失败");
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="设置"
				description={me ? `Access：${displayName(me)}（${me.email}）` : "加载身份…"}
			/>
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
				<Button type="submit" data-testid="pat-submit">
					添加账号
				</Button>
			</form>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>账号</TableHead>
						<TableHead>末四位</TableHead>
						<TableHead>scopes</TableHead>
						<TableHead>当前</TableHead>
						<TableHead>操作</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{accounts.map((row) => (
						<TableRow key={row.id}>
							<TableCell>{row.login}</TableCell>
							<TableCell>{row.token_last4}</TableCell>
							<TableCell>{row.scopes}</TableCell>
							<TableCell>{row.is_active ? "是" : "否"}</TableCell>
							<TableCell className="flex gap-2">
								<Button
									type="button"
									variant="secondary"
									disabled={row.is_active}
									onClick={() => {
										void activateAccount(row.id).then(() => reload());
									}}
								>
									激活
								</Button>
								<Button type="button" variant="destructive" onClick={() => setPendingId(row.id)}>
									删除
								</Button>
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
					return deleteAccount(pendingId).then(() => {
						setPendingId(null);
						return reload();
					});
				}}
			/>
		</div>
	);
}
