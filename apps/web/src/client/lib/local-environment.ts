export type LocalEnvironment = Readonly<{
	mode: "local" | "prod";
	instanceId: string;
	csrfToken: string;
}>;

declare global {
	interface Window {
		__GIRAFFE_LOCAL__?: LocalEnvironment;
	}
}

const initial = typeof window === "undefined" ? undefined : window.__GIRAFFE_LOCAL__;
const environment = initial ? Object.freeze({ ...initial }) : undefined;

export function getLocalEnvironment(): LocalEnvironment | undefined {
	return environment;
}

export function isRemoteReadOnly(): boolean {
	return environment?.mode === "prod";
}
