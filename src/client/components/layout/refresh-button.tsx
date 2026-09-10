import { Button, toast } from "@nocoo/basalt";
import { RefreshCw } from "lucide-react";
import { useSyncExternalStore } from "react";
import { refreshInFlight, subscribeRefresh } from "../../viewmodels/refresh";

export function RefreshButton({
	run,
	onError,
}: {
	run: () => Promise<unknown>;
	onError?: (err: unknown) => void;
}) {
	const busy = useSyncExternalStore(subscribeRefresh, refreshInFlight, refreshInFlight);
	return (
		<Button
			type="button"
			size="sm"
			icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
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
