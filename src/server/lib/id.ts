const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-";

export function createId(size = 21): string {
	const bytes = crypto.getRandomValues(new Uint8Array(size));
	let id = "";
	for (const byte of bytes) {
		id += ALPHABET.charAt(byte % 64);
	}
	return id;
}
