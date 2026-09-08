import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./index.css";

let stored: string | null = null;
try {
	stored = window.localStorage.getItem("theme");
} catch {
	// Continue with the system theme when browser storage is denied.
}
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const isDark = stored === "dark" || (stored !== "light" && prefersDark);
document.documentElement.classList.toggle("dark", isDark);
document.documentElement.classList.toggle("light", !isDark);
document.documentElement.dataset.mode = isDark ? "dark" : "light";
const giraffePrimary = "87 53% 33%";
document.documentElement.style.setProperty("--basalt-primary", giraffePrimary);
document.documentElement.style.setProperty("--basalt-primary-foreground", "0 0% 100%");
document.documentElement.style.setProperty("--basalt-ring", giraffePrimary);

const root = document.getElementById("root");
if (!root) {
	throw new Error("root missing");
}
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
