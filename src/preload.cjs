const { contextBridge, ipcRenderer } = require("electron");

const TOP_BAR = ".p-ia4_top_nav";
const BUTTON = 34;
const GAP = 3;
const EDGE = 3;

contextBridge.exposeInMainWorld("slackDesktop", { show: () => ipcRenderer.send("show") });
contextBridge.executeInMainWorld({
	func: () => {
		const WebNotification = window.Notification;
		window.Notification = class extends WebNotification {
			constructor(...args) {
				super(...args);
				this.addEventListener("click", () => window.slackDesktop.show());
			}
		};
	},
});

const STYLE = `
#slack-desktop-controls { position: fixed; top: ${EDGE}px; right: ${EDGE}px; z-index: 2147483647; display: flex; gap: ${GAP}px; -webkit-app-region: no-drag; color: var(--controls-fg, rgba(0, 0, 0, 0.8)); }
#slack-desktop-controls button { all: unset; width: ${BUTTON}px; height: ${BUTTON}px; display: grid; place-items: center; }
#slack-desktop-controls span { width: 24px; height: 24px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, currentColor 10%, transparent); transition: background 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94); }
#slack-desktop-controls button:hover span { background: color-mix(in srgb, currentColor 15%, transparent); }
#slack-desktop-controls button:active span { background: color-mix(in srgb, currentColor 30%, transparent); }
#slack-desktop-controls i { width: 16px; height: 16px; background: currentColor; -webkit-mask: var(--icon) center / 16px no-repeat; }
${TOP_BAR} { -webkit-app-region: drag; }
${TOP_BAR}__native_ui_spacer { -webkit-app-region: drag !important; }
${TOP_BAR} :is(button, a, input, textarea, [role=button], [role=combobox], [contenteditable], [tabindex]) { -webkit-app-region: no-drag; }
`;

const colors = (s) => (s.match(/rgba?\([^)]+\)/g) || []).map((c) => {
	const [r, g, b, a = 1] = c.match(/[\d.]+/g).map(Number);
	return [r, g, b, a];
});

const layers = (s) => {
	const out = [];
	let depth = 0, start = 0;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "(") depth++;
		else if (s[i] === ")") depth--;
		else if (s[i] === "," && !depth) {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	return [...out, s.slice(start)];
};

const average = (stops) => {
	const alpha = stops.reduce((sum, c) => sum + c[3], 0);
	if (!alpha) return null;
	return [0, 1, 2].map((i) => stops.reduce((sum, c) => sum + c[i] * c[3], 0) / alpha).concat(alpha / stops.length);
};

const luminance = (rgb) => rgb.reduce((sum, v, i) => {
	v /= 255;
	return sum + [0.2126, 0.7152, 0.0722][i] * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
}, 0);

function foregroundFor(x, y) {
	const rgb = [0, 0, 0];
	let cover = 0;
	const paint = (c) => {
		if (!c) return;
		const weight = (1 - cover) * c[3];
		for (let i = 0; i < 3; i++) rgb[i] += c[i] * weight;
		cover += weight;
	};
	for (const el of document.elementsFromPoint(x, y)) {
		if (el.closest("#slack-desktop-controls")) continue;
		const style = getComputedStyle(el);
		for (const layer of layers(style.backgroundImage)) paint(average(colors(layer)));
		paint(colors(style.backgroundColor)[0]);
		if (cover > 0.99) break;
	}
	paint([255, 255, 255, 1]);
	const l = luminance(rgb);
	return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "rgba(0, 0, 0, 0.8)" : "white";
}

let controls, padding, icons, maximized = false;

function renderControls(layout) {
	controls.replaceChildren(...layout.map((action) => {
		const button = document.createElement("button");
		button.dataset.action = action;
		button.setAttribute("aria-label", action);
		button.innerHTML = "<span><i></i></span>";
		button.addEventListener("click", () => ipcRenderer.send("window", action));
		return button;
	}));
	updateIcons();
	const width = layout.length ? layout.length * BUTTON + (layout.length - 1) * GAP + EDGE + 1 : 0;
	padding.textContent = width ? `${TOP_BAR} { padding-right: ${width}px !important; }` : "";
}

function updateIcons() {
	for (const button of controls.children) {
		const name = button.dataset.action === "maximize" && maximized ? "restore" : button.dataset.action;
		button.querySelector("i").style.setProperty("--icon", `url("${icons[name]}")`);
	}
}

function updateContrast() {
	if (document.hidden || !controls.isConnected) return;
	const box = controls.getBoundingClientRect();
	controls.style.setProperty("--controls-fg", foregroundFor(box.left + box.width / 2, box.top + box.height / 2));
}

window.addEventListener("DOMContentLoaded", async () => {
	const style = document.createElement("style");
	style.textContent = STYLE;
	padding = document.createElement("style");
	controls = document.createElement("div");
	controls.id = "slack-desktop-controls";
	document.documentElement.append(style, padding, controls);

	const state = await ipcRenderer.invoke("controls");
	icons = state.icons;
	maximized = state.maximized;
	renderControls(state.layout);
	ipcRenderer.on("layout", (_e, layout) => renderControls(layout));
	ipcRenderer.on("maximized", (_e, value) => {
		maximized = value;
		updateIcons();
	});

	updateContrast();
	setInterval(updateContrast, 1000);
	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTimeout(updateContrast, 300));
});
