import { useEffect, useState } from "react";
import { type ProjectIdentity, projectKey } from "../../../lib/project-identity";
import { cachedProjectIdentity, loadProjectIdentity } from "../../viewmodels/project-identity";

export function useProjectIdentity(repository: string): ProjectIdentity | null {
	const key = projectKey(repository) ?? "";
	const [state, setState] = useState(() => ({ key, project: cachedProjectIdentity(key) }));
	useEffect(() => {
		let active = true;
		void loadProjectIdentity(key).then((project) => {
			if (active) setState({ key, project });
		});
		return () => {
			active = false;
		};
	}, [key]);
	return state.key === key ? state.project : cachedProjectIdentity(key);
}
