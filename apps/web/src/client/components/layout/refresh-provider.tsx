import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { RefreshViewModel, refreshActive } from "../../viewmodels/refresh";
import { subscribeSession } from "../../viewmodels/session";

const RefreshContext = createContext<RefreshViewModel | null>(null);

export function useRefreshModel() {
	return useContext(RefreshContext);
}

export function RefreshProvider({ children }: { children: ReactNode }) {
	const [model] = useState(() => new RefreshViewModel());
	const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
	const active = refreshActive(state.run) || state.starting;
	useEffect(() => subscribeSession(model.accountChanged), [model]);
	useEffect(() => {
		const read = () => {
			if (document.visibilityState === "visible") void model.read();
		};
		read();
		window.addEventListener("focus", read);
		document.addEventListener("visibilitychange", read);
		return () => {
			window.removeEventListener("focus", read);
			document.removeEventListener("visibilitychange", read);
		};
	}, [model]);
	useEffect(() => {
		const timer = setInterval(
			() => {
				if (document.visibilityState === "visible") void model.read();
			},
			active ? 3000 : 60_000,
		);
		return () => clearInterval(timer);
	}, [model, active]);
	return <RefreshContext value={model}>{children}</RefreshContext>;
}
