import { app, BrowserWindow, Menu, MenuItem, Notification, Tray, clipboard, desktopCapturer, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const APP_ID = "net.donnybeelo.Slack";
const URL = "https://app.slack.com/client";
const ASSETS = path.join(import.meta.dirname, "..", "assets").replace("app.asar", "app.asar.unpacked");
const PORTAL = ["--session", "--dest", "org.freedesktop.portal.Desktop", "--object-path", "/org/freedesktop/portal/desktop"];
const SSB_REDIR = "redir=%2Fssb%2Fsignin_redirect%3Frevoke_parent_session_if_ssb%3D1%26is_ssb_browser_signin%3D1";
const SLACK_HOST = /^https:\/\/([a-z0-9-]+\.)*slack\.com(\/|$)/;
const SLACK_SIGNIN = /^https:\/\/([a-z0-9-]+\.)*slack\.com\/(signin\/oauth\/[^/?]+\/start|sso\/saml)/;

app.setPath("userData", path.join(app.getPath("appData"), APP_ID));
app.setDesktopName(`${APP_ID}.desktop`);
app.userAgentFallback = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split(".")[0]}.0.0.0 Safari/537.36`;

if (!app.requestSingleInstanceLock()) {
	app.quit();
	process.exit(0);
}

const STATE = path.join(app.getPath("userData"), "window.json");
const startHidden = process.argv.some((a) => a === "-u" || a === "--background");
let win, tray, quitting = false, trayIcon = "tray-rest";
const overlay = { color: "rgba(0, 0, 0, 0)" };

// Black or white window-button symbols, from the average luminance of the
// page pixels under the buttons
async function updateSymbolColor() {
	if (!win.isVisible() || win.isMinimized()) return;
	const [width] = win.getContentSize();
	const strip = 140;
	const image = await win.webContents
		.capturePage({ x: Math.max(0, width - strip), y: 0, width: Math.min(strip, width), height: overlay.height ?? 40 })
		.catch(() => null);
	const bitmap = image?.toBitmap();
	if (!bitmap?.length) return;
	const linear = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	let total = 0, samples = 0;
	for (let i = 0; i < bitmap.length; i += 16) {
		total += 0.0722 * linear(bitmap[i]) + 0.7152 * linear(bitmap[i + 1]) + 0.2126 * linear(bitmap[i + 2]);
		samples++;
	}
	// White symbols unless the background is light
	const symbolColor = total / samples > 0.4 ? "#000000" : "#ffffff";
	if (symbolColor === overlay.symbolColor) return;
	overlay.symbolColor = symbolColor;
	win.setTitleBarOverlay(overlay);
}

const showWindow = () => {
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
};
const toggleWindow = () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow());
const quit = () => {
	quitting = true;
	app.quit();
};

function loadState() {
	try {
		return JSON.parse(fs.readFileSync(STATE, "utf8"));
	} catch {
		return { width: 1200, height: 800, maximized: false };
	}
}

function saveState() {
	const { width, height } = win.getNormalBounds();
	fs.writeFileSync(STATE, JSON.stringify({ width, height, maximized: win.isMaximized(), overlayHeight: overlay.height }));
}


function faviconState(image) {
	const { width, height } = image.getSize();
	const bitmap = image.toBitmap();
	const at = (x, y) => {
		const i = (y * width + x) * 4;
		return [bitmap[i + 2], bitmap[i + 1], bitmap[i], bitmap[i + 3]];
	};
	const pureRed = ([r, g, b, a]) => a > 200 && r > 240 && g < 50 && b < 50;
	let count = 0, sumX = 0, sumY = 0;
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++)
			if (pureRed(at(x, y))) {
				count++;
				sumX += x;
				sumY += y;
			}
	if (count > (width * height) / 100) return pureRed(at(Math.round(sumX / count), Math.round(sumY / count))) ? "mention" : "unread";
	const [r, g, b] = at(1, height - 2);
	if (!(r > 40 && r < 120 && g < 60 && b > 40 && b < 120)) return "rest";
	const [cornerR, cornerG] = at(width - 2, 1);
	if (cornerR > 180 && cornerG < 80) return "mention";
	for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i] > 235 && bitmap[i + 1] > 235 && bitmap[i + 2] > 235) return "unread";
	return "rest";
}

function setUnread(favicon) {
	if (!favicon?.startsWith("data:image/")) return;
	const state = faviconState(nativeImage.createFromDataURL(favicon));
	const icon = { mention: "tray-highlight", unread: "tray-unread", rest: "tray-rest" }[state];
	if (icon !== trayIcon) tray.setImage(path.join(ASSETS, `${(trayIcon = icon)}.png`));
	app.setBadgeCount(state === "mention" ? 1 : 0);
}

function browserUri(uri, currentUri) {
	if (SLACK_SIGNIN.test(uri)) {
		const rest = uri.replace(/([?&])redir=[^&]*(&|$)/, "$1").replace(/[?&]$/, "");
		return `${rest}${rest.includes("?") ? "&" : "?"}${SSB_REDIR}`;
	}
	if (SLACK_HOST.test(uri) || !/^(https?|mailto):/.test(uri)) return null;
	if (SLACK_HOST.test(currentUri) && /signin|\/sso/.test(currentUri))
		return `${currentUri.match(SLACK_HOST)[0].replace(/\/$/, "")}/ssb/signin_redirect`;
	return uri;
}

function magicLogin(uri) {
	const tokens = [...uri.matchAll(/([A-Z0-9]+)\/magic-login\/([A-Za-z0-9-]+)/gi)]
		.map(([, team, token]) => `z-app-${team.toUpperCase()}-${token}`);
	if (!tokens.length) return;
	const host = new URLSearchParams(uri.split("?")[1] ?? "").get("host");
	const base = host && /^([a-z0-9-]+\.)*slack\.com$/.test(host) ? host : "app.slack.com";
	win.webContents.once("did-stop-loading", () => win.loadURL(URL));
	win.loadURL(`https://${base}/api/auth.loginMagicBulk?magic_tokens=${tokens.join(",")}&ssb=1`);
}

function handleArgs(argv) {
	for (const arg of argv) if (arg.startsWith("slack:")) magicLogin(arg);
}

function contextMenu(params) {
	const menu = new Menu();
	const contents = win.webContents;
	for (const suggestion of params.dictionarySuggestions)
		menu.append(new MenuItem({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) }));
	if (params.misspelledWord) {
		menu.append(new MenuItem({
			label: "Add to Dictionary",
			click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
		}));
		menu.append(new MenuItem({ type: "separator" }));
	}
	if (params.linkURL) menu.append(new MenuItem({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }));
	if (params.mediaType === "image") menu.append(new MenuItem({ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) }));
	const flags = params.editFlags;
	for (const [flag, role] of [["canCut", "cut"], ["canCopy", "copy"], ["canPaste", "paste"], ["canSelectAll", "selectAll"]])
		if (flags[flag] && (role !== "selectAll" || params.isEditable)) menu.append(new MenuItem({ role }));
	if (menu.items.length) menu.popup({ window: win });
}

function createWindow() {
	const state = loadState();
	if (state.overlayHeight) overlay.height = state.overlayHeight;
	win = new BrowserWindow({
		width: state.width, height: state.height, minWidth: 500, minHeight: 400,
		titleBarStyle: "hidden", titleBarOverlay: overlay, show: false, title: "Slack",
		icon: path.join(ASSETS, "slack-512x512.png"),
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1a1d21" : "#ffffff",
		webPreferences: { preload: path.join(import.meta.dirname, "preload.cjs"), spellcheck: true },
	});
	if (state.maximized) win.maximize();
	if (!startHidden) win.show();

	const contents = win.webContents;
	const session = contents.session;

	win.on("close", (e) => {
		saveState();
		if (quitting) return;
		e.preventDefault();
		win.hide();
	});

	contents.on("page-favicon-updated", (_e, favicons) => setUnread(favicons[0]));
	contents.on("context-menu", (_e, params) => contextMenu(params));
	contents.on("before-input-event", (e, input) => {
		if (input.type !== "keyDown" || !input.control) return;
		const key = input.key.toLowerCase();
		const actions = {
			q: quit,
			r: () => contents.reload(),
			i: () => input.shift && contents.toggleDevTools(),
			"=": () => contents.setZoomLevel(contents.getZoomLevel() + 0.5),
			"+": () => contents.setZoomLevel(contents.getZoomLevel() + 0.5),
			"-": () => contents.setZoomLevel(contents.getZoomLevel() - 0.5),
			0: () => contents.setZoomLevel(0),
		};
		if (actions[key]) {
			actions[key]();
			e.preventDefault();
		}
	});

	contents.on("will-navigate", (e) => {
		if (!e.isMainFrame) return;
		const external = browserUri(e.url, contents.getURL());
		if (!external) return;
		e.preventDefault();
		shell.openExternal(external);
	});
	contents.setWindowOpenHandler(({ url }) => {
		if (url === "about:blank") return { action: "allow" };
		if (/^https:\/\/files\.slack\.com\//.test(url)) contents.downloadURL(url);
		else shell.openExternal(browserUri(url, contents.getURL()) ?? url);
		return { action: "deny" };
	});

	const allowed = ["media", "notifications", "display-capture", "fullscreen", "clipboard-sanitized-write", "clipboard-read"];
	session.setPermissionRequestHandler((_c, permission, callback) => callback(allowed.includes(permission)));
	session.setPermissionCheckHandler((_c, permission) => allowed.includes(permission));
	session.setDisplayMediaRequestHandler(async (_request, callback) => {
		const [source] = await desktopCapturer.getSources({ types: ["screen", "window"] }).catch(() => []);
		callback(source ? { video: source } : {});
	});
	session.on("will-download", (_e, item) => {
		item.setSavePath(path.join(app.getPath("downloads"), item.getFilename()));
		item.once("done", (_d, state) => {
			if (state === "completed") new Notification({ title: "Download complete", body: item.getFilename() }).show();
		});
	});

	win.loadURL(URL);
}

function watchSetting(namespace, key, onChange) {
	const read = () => execFileSync("gdbus",
		["call", ...PORTAL, "--method", "org.freedesktop.portal.Settings.ReadOne", namespace, key], { encoding: "utf8" });
	onChange(read());
	const monitor = spawn("gdbus", ["monitor", ...PORTAL]);
	monitor.stdout.on("data", (chunk) => String(chunk).includes(`'${namespace}', '${key}'`) && onChange(read()));
	app.on("will-quit", () => monitor.kill());
}

app.whenReady().then(() => {
	Menu.setApplicationMenu(null);
	watchSetting("org.freedesktop.appearance", "color-scheme",
		(value) => (nativeTheme.themeSource = value.includes("uint32 1") ? "dark" : "light"));
	createWindow();
	handleArgs(process.argv);

	ipcMain.on("show", showWindow);
	ipcMain.on("title-bar-height", (_e, height) => {
		overlay.height = Math.round(height * win.webContents.getZoomFactor());
		win.setTitleBarOverlay(overlay);
	});
	setInterval(updateSymbolColor, 250);

	tray = new Tray(path.join(ASSETS, "tray-rest.png"));
	tray.setToolTip("Slack");
	tray.setContextMenu(Menu.buildFromTemplate([
		{ label: "Show Slack", click: showWindow },
		{ type: "separator" },
		{ label: "Quit", click: quit },
	]));
	tray.on("click", toggleWindow);
});

app.on("second-instance", (_e, argv) => {
	handleArgs(argv);
	showWindow();
});
app.on("before-quit", () => (quitting = true));
