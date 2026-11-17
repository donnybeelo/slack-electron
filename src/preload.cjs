const { contextBridge, ipcRenderer } = require("electron");

const TOP_BAR = ".p-ia4_top_nav";

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
${TOP_BAR} { -webkit-app-region: drag; padding-right: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)) !important; }
${TOP_BAR}__native_ui_spacer { -webkit-app-region: drag !important; }
${TOP_BAR} :is(button, a, input, textarea, [role=button], [role=combobox], [contenteditable], [tabindex]) { -webkit-app-region: no-drag; }
`;

window.addEventListener("DOMContentLoaded", () => {
	const style = document.createElement("style");
	style.textContent = STYLE;
	document.documentElement.append(style);

	let last;
	setInterval(() => {
		const bar = document.querySelector(TOP_BAR);
		if (!bar) return;
		const height = bar.getBoundingClientRect().height;
		const key = `${height}|${devicePixelRatio}`;
		if (key === last) return;
		last = key;
		ipcRenderer.send("title-bar-height", height);
	}, 500);
});
