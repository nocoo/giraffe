import { Button, toast } from "@nocoo/basalt";
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
			loading={busy}
			onClick={() => {
				void run()
					.then((result) => {
						if (result === false) {
							return;
						}
						toast.success("已刷新");
					})
					.catch(onError);
			}}
		>
			刷新
		</Button>
	);
}
