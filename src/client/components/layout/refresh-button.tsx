import { Button, toast } from "@nocoo/basalt";
import { Loader } from "@nocoo/basalt/components/loader";
import { useSyncExternalStore } from "react";
import { refreshInFlight, subscribeRefresh } from "../../viewmodels/refresh";

export function RefreshButton({
	run,
	onError,
	variant = "secondary",
}: {
	run: () => Promise<unknown>;
	onError?: (err: unknown) => void;
	variant?: "secondary" | "default";
}) {
	const busy = useSyncExternalStore(subscribeRefresh, refreshInFlight, refreshInFlight);
	return (
		<Button
			type="button"
			{...(variant === "default" ? {} : { variant })}
			disabled={busy}
			onClick={() => {
				void run()
					.then(() => {
						toast("已刷新");
					})
					.catch(onError);
			}}
		>
			{busy ? <Loader size={14} /> : null}
			刷新
		</Button>
	);
}
