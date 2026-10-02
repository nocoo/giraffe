import { useEffect, useEffectEvent } from "react";
export function useAnalysisRead<T>(
	load: () => Promise<T>,
	receive: (data: T) => void,
	fail: () => void,
) {
	const read = useEffectEvent(load),
		apply = useEffectEvent(receive),
		error = useEffectEvent(fail);
	useEffect(() => {
		let cancelled = false,
			pending = false,
			failures = 0;
		let timer: ReturnType<typeof setTimeout>;
		async function poll() {
			clearTimeout(timer);
			if (cancelled || pending) return;
			if (document.visibilityState !== "visible") return;
			pending = true;
			try {
				const value = await read();
				if (!cancelled) {
					apply(value);
					failures = 0;
				}
			} catch {
				if (!cancelled) {
					failures++;
					error();
				}
			} finally {
				pending = false;
				if (!cancelled)
					timer = setTimeout(() => void poll(), Math.min(60000, 15000 * 2 ** failures));
			}
		}
		const visible = () => {
			if (document.visibilityState === "visible") void poll();
			else clearTimeout(timer);
		};
		void poll();
		document.addEventListener("visibilitychange", visible);
		window.addEventListener("focus", visible);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener("focus", visible);
		};
	}, []);
}
