import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dirname, "..");
const source = join(root, "logo.png");
const out = join(root, "apps/web/public");

mkdirSync(out, { recursive: true });

async function write(name: string, size: number, padding = 0) {
	const inset = Math.round(size * padding);
	const canvas = sharp({
		create: {
			width: size,
			height: size,
			channels: 4,
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		},
	});
	const logo = await sharp(source)
		.resize(size - inset * 2, size - inset * 2, { fit: "contain" })
		.png()
		.toBuffer();
	await canvas
		.composite([{ input: logo, gravity: "centre" }])
		.png()
		.toFile(join(out, name));
}

await write("icon-192.png", 192);
await write("icon-512.png", 512);
await write("icon-512-maskable.png", 512, 0.12);
await sharp(source)
	.resize(180, 180, { fit: "contain" })
	.png()
	.toFile(join(out, "apple-touch-icon.png"));
await sharp(source).resize(32, 32, { fit: "contain" }).png().toFile(join(out, "logo-32.png"));
console.log("PWA icons written to apps/web/public");
