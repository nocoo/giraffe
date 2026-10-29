import { useEffect, useEffectEvent } from "react";
import { cacheGeneration } from "../../viewmodels/session";
import { useRefreshModel } from "./refresh-provider";

export function useSnapshotRead<Value>(
	load: () => Promise<Value>,
	receive: (value: Value) => void,
	onError: (error: unknown) => void,
	enabled = true,
	initialRead = true,
	resourceKey = "",
): void {
	const refreshModel = useRefreshModel();
	const read = useEffectEvent(load);
	const apply = useEffectEvent(receive);
	const fail = useEffectEvent(onError);
	const currentKey = useEffectEvent(() => resourceKey);
	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		let pending = false;
		let requested = false;
		async function revalidate() {
			if (document.visibilityState !== "visible" || pending) return;
			pending = true;
			const generation = cacheGeneration();
			try {
				const result = await read();
				if (generation !== cacheGeneration()) requested = true;
				if (!cancelled && !requested && resourceKey === currentKey()) apply(result);
			} catch (error) {
				if (!cancelled && !requested && generation === cacheGeneration()) fail(error);
			} finally {
				pending = false;
				if (requested && !cancelled) {
					requested = false;
					void revalidate();
				}
			}
		}
		const refresh = () => {
			void revalidate();
		};
		const unsubscribe = refreshModel?.subscribeData(() => {
			if (pending) requested = true;
			else refresh();
		});
		if (initialRead) refresh();
		const timer = setInterval(refresh, 60_000);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			cancelled = true;
			unsubscribe?.();
			clearInterval(timer);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [enabled, initialRead, refreshModel, resourceKey]);
}
