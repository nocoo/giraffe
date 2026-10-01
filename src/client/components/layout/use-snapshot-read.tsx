import { useEffect, useEffectEvent } from "react";

export function useSnapshotRead<Value>(
	load: () => Promise<Value>,
	receive: (value: Value) => void,
	onError: (error: unknown) => void,
	enabled = true,
	initialRead = true,
): void {
	const read = useEffectEvent(load);
	const apply = useEffectEvent(receive);
	const fail = useEffectEvent(onError);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let pending = false;
		async function revalidate() {
			if (document.visibilityState !== "visible" || pending) return;
			pending = true;
			try {
				const result = await read();
				if (!cancelled) apply(result);
			} catch (error) {
				if (!cancelled) fail(error);
			} finally {
				pending = false;
			}
		}
		const refresh = () => {
			void revalidate();
		};
		if (initialRead) refresh();
		const timer = setInterval(refresh, 60_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			cancelled = true;
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [enabled, initialRead]);
}
