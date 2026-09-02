import { apiGet } from "../lib/api";

export type MeIdentity = {
	email: string;
	name: string;
};

export function displayName(me: MeIdentity): string {
	return me.name.trim() === "" ? me.email : me.name;
}

export async function loadMe(): Promise<MeIdentity> {
	return apiGet<MeIdentity>("me");
}
