// Client-half source template. `src/build.mjs` fills the two placeholders
// below and writes the result to lib/client.js.
//
// What lives here:
//   1. a stylesheet making the app frame / sidebar and the transcript column
//      translucent by one shared amount,
//   2. a floating panel: wallpaper choices, opacity, dim, fill mode,
//   3. local import of images (downscaled data URL) and videos (raw Blob),
//      both kept in IndexedDB,
//   4. "follow the desktop wallpaper", fetched from the host half's route.
//
// Bundled choices can be hidden and restored; imported ones can be deleted.
window.__ModuleLoader__.load({
	id: "dsh-wallpaper-bundle",
	factory(require) {
		const PLUGIN_ID = "dsh-wallpaper-bundle";
		const BUNDLED = __DSH_WALLPAPER_IMAGES__;
		const DEFAULTS = __DSH_WALLPAPER_DEFAULTS__;
		const STORAGE_KEY = "dsh-wallpaper:state";
		const DB_NAME = "dsh-wallpaper";
		const DB_STORE = "images";
		const CUSTOM_KEY = "customs";
		const CSS_ID = "dsh-wallpaper-css";
		const HOST_ATTR = "data-dsh-wallpaper-ui";
		const VIDEO_ID = "dsh-wallpaper-video";
		const SCRIM_ID = "dsh-wallpaper-scrim";
		const DESKTOP_ROUTE = "/_dsh-wallpaper/desktop";
		const DESKTOP_ID = "desktop";
		const MAX_SIDE = 2560;
		const MAX_IMPORTS = 4;
		const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
		/** How often an active "follow the desktop" checks for a new image. */
		const POLL_MS = 60000;

		/** Light and dark source colours per token. */
		const TOKENS = {
			frame: { light: "50", dark: "900" },
			base: { light: "00", dark: "950" },
			layer1: { light: "00", dark: "875" },
			layer2: { light: "00", dark: "850" },
			layer3: { light: "00", dark: "800" },
		};

		const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

		// --- persistence ------------------------------------------------------

		function loadState() {
			const fallback = { fit: "cover", hidden: [], ...DEFAULTS };
			try {
				const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
				if (!saved) return fallback;
				return {
					preset: typeof saved.preset === "string" ? saved.preset : fallback.preset,
					opacity: clamp(Number(saved.opacity ?? fallback.opacity), 5, 100),
					dim: clamp(Number(saved.dim ?? fallback.dim), 0, 0.9),
					fit: saved.fit === "contain" ? "contain" : "cover",
					hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((id) => typeof id === "string") : [],
				};
			} catch {
				return fallback;
			}
		}

		function saveState(state) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch {
				/* private mode or quota: the sheet still applies for this session */
			}
		}

		function openDb() {
			return new Promise((resolve, reject) => {
				const request = indexedDB.open(DB_NAME, 1);
				request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}

		async function idbGet(key) {
			const db = await openDb();
			return new Promise((resolve, reject) => {
				const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		}

		async function idbSet(key, value) {
			const db = await openDb();
			return new Promise((resolve, reject) => {
				const tx = db.transaction(DB_STORE, "readwrite");
				tx.objectStore(DB_STORE).put(value, key);
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error);
			});
		}

		/** Stored records keep blobs; the live list keeps playable URLs. */
		function hydrate(record) {
			if (record.kind === "video" && record.blob) {
				return { id: record.id, label: record.label, kind: "video", url: URL.createObjectURL(record.blob) };
			}
			return { id: record.id, label: record.label, kind: "image", url: record.url };
		}

		// --- stylesheet -------------------------------------------------------

		function cssFor(state, images) {
			const entry = images.find((item) => item.id === state.preset);
			if (!entry) return "";

			const scrim =
				state.dim > 0
					? `linear-gradient(rgba(0,0,0,${state.dim}), rgba(0,0,0,${state.dim})), `
					: "";
			const mix = (token, pct) =>
				`color-mix(in srgb, var(--dsw-static-neutral-bluish-${token}) ${pct}%, transparent)`;
			const block = (variant) => {
				const p = (key) => TOKENS[key][variant];
				const o = state.opacity;
				return [
					`--dsw-specific-sidebar-fill: ${mix(p("frame"), o)};`,
					`--dsw-alias-bg-base: ${mix(p("base"), o)};`,
					`--dsw-alias-bg-layer-1: ${mix(p("layer1"), Math.min(100, o + 6))};`,
					`--dsw-alias-bg-layer-2: ${mix(p("layer2"), Math.min(100, o + 10))};`,
					`--dsw-alias-bg-layer-3: ${mix(p("layer3"), Math.min(100, o + 14))};`,
				].join("\n\t");
			};

			// Video: the canvas stays fully transparent, the <video> layer paints
			// instead. Its scrim is a separate element.
			const fit = state.fit === "contain" ? "contain" : "cover";
			const paint =
				entry.kind === "video"
					? ""
					: `background-image: ${scrim}url("${entry.url}");
	background-position: center center;
	background-repeat: no-repeat;
	background-size: ${fit};
	background-attachment: fixed;`;

			return `/* dsh-wallpaper: ${entry.id} (${entry.kind}) */
html body {
	background-color: transparent;
	${paint}
	${block("light")}
}
html body[data-ds-dark-theme] {
	${block("dark")}
}
`;
		}

		// --- panel ------------------------------------------------------------

		const PANEL_CSS = `
:host { all: initial; }
.root { position: fixed; right: 16px; bottom: 88px; z-index: 2147483000;
	font: 12px/1.45 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #e8eaed; }
.trigger { display: flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px;
	border: 1px solid rgba(255,255,255,.14); border-radius: 999px; cursor: pointer;
	background: rgba(28,29,32,.92); box-shadow: 0 6px 20px rgba(0,0,0,.35); }
.trigger:hover { background: rgba(40,42,46,.95); }
.panel { position: absolute; right: 0; bottom: 38px; width: 272px; padding: 12px;
	border: 1px solid rgba(255,255,255,.14); border-radius: 14px;
	background: rgba(24,25,28,.97); box-shadow: 0 12px 32px rgba(0,0,0,.45); }
.panel[hidden] { display: none; }
.group + .group { margin-top: 12px; }
.title { color: #9aa0a6; margin-bottom: 6px; display: flex; justify-content: space-between; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.row + .row { margin-top: 6px; }
.chip { position: relative; display: inline-flex; align-items: stretch; max-width: 100%; }
/* Remove badge: hidden at rest, floats over the chip's top-right corner on
   hover so the row never reflows. */
.chip .del { position: absolute; top: -5px; right: -5px; z-index: 1;
	width: 16px; height: 16px; padding: 0; line-height: 1; font-size: 11px;
	display: grid; place-items: center; cursor: pointer; color: #c9ccd1;
	border: 1px solid rgba(255,255,255,.22); border-radius: 50%;
	background: #2a2c31; box-shadow: 0 2px 6px rgba(0,0,0,.45);
	opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.chip:hover .del, .chip:focus-within .del { opacity: 1; pointer-events: auto; }
.chip .del:hover { background: #c0392b; border-color: #c0392b; color: #fff; }
.choice { flex: 0 0 auto; max-width: 100%; height: 26px; padding: 0 10px; border-radius: 8px;
	cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); color: inherit; }
.choice:hover { background: rgba(255,255,255,.1); }
.choice[aria-pressed="true"] { background: #4176e6; border-color: #4176e6; color: #fff; }
.fold { margin-top: 12px; }
.fold > summary { cursor: pointer; color: #9aa0a6; list-style: none;
	display: flex; align-items: center; gap: 4px; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::before { content: "▸"; font-size: 10px; transition: transform .12s ease; }
.fold[open] > summary::before { transform: rotate(90deg); }
.fold > summary:hover { color: #e8eaed; }
.fold > .row { margin-top: 6px; }
.fit { flex: 1; height: 24px; border-radius: 8px; cursor: pointer; color: inherit;
	border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); }
.fit:hover { background: rgba(255,255,255,.1); }
.fit[aria-pressed="true"] { background: #4176e6; border-color: #4176e6; color: #fff; }
.slider { width: 100%; margin: 2px 0 0; accent-color: #4176e6; }
.import { width: 100%; height: 28px; margin-top: 8px; border-radius: 8px; cursor: pointer;
	border: 1px dashed rgba(255,255,255,.22); background: transparent; color: #9aa0a6; }
.import:hover { border-color: #4176e6; color: #e8eaed; }
.restore { margin-top: 6px; padding: 0; border: 0; background: none; cursor: pointer;
	color: #6f9be8; font: inherit; }
.restore:hover { text-decoration: underline; }
.note { color: #7d838a; margin-top: 8px; }
`;

		function mount() {
			if (typeof document === "undefined") return () => {};
			const state = loadState();
			let hidden = new Set(state.hidden);
			/** Raw records as stored: blobs and data URLs. */
			let records = [];
			/** Hydrated view of `records`: playable object URLs, built once. */
			let customs = [];
			let desktopEntry;
			let desktopEtag;
			let desktopTimer;

			let sheet = document.getElementById(CSS_ID);
			if (!sheet) {
				sheet = document.createElement("style");
				sheet.id = CSS_ID;
				sheet.dataset.plugin = PLUGIN_ID;
				sheet.dataset.pluginCss = `${PLUGIN_ID}/wallpaper.css`;
				document.head.appendChild(sheet);
			}

			// Video and scrim layers live in the page, under the app.
			let video = document.getElementById(VIDEO_ID);
			if (!video) {
				video = document.createElement("video");
				video.id = VIDEO_ID;
				video.muted = true;
				video.loop = true;
				video.autoplay = true;
				video.playsInline = true;
				video.style.cssText = [
					"position:fixed", "inset:0", "width:100%", "height:100%",
					"object-fit:cover", "z-index:-2", "pointer-events:none", "display:none",
				].join(";");
				document.body.appendChild(video);
			}
			let scrim = document.getElementById(SCRIM_ID);
			if (!scrim) {
				scrim = document.createElement("div");
				scrim.id = SCRIM_ID;
				scrim.style.cssText =
					"position:fixed;inset:0;z-index:-1;pointer-events:none;display:none";
				document.body.appendChild(scrim);
			}

			let host = document.querySelector(`[${HOST_ATTR}]`);
			if (!host) {
				host = document.createElement("div");
				host.setAttribute(HOST_ATTR, "");
				document.body.appendChild(host);
			}
			const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
			shadow.innerHTML = `
<style>${PANEL_CSS}</style>
<div class="root">
	<button class="trigger" type="button">🖼 壁纸</button>
	<div class="panel" hidden>
		<div class="group">
			<div class="title">壁纸</div>
			<div class="row" data-role="presets"></div>
			<div class="row" data-role="desktop-row"></div>
			<button class="import" type="button" data-role="import">＋ 导入图片 / 视频…</button>
			<input type="file" accept="image/*,video/*" data-role="file" hidden>
		</div>
		<details class="fold">
			<summary>画面填充：<span data-role="fit-value">填充</span></summary>
			<div class="row">
				<button class="fit" type="button" data-fit="cover">填充（裁边）</button>
				<button class="fit" type="button" data-fit="contain">适应（留边）</button>
			</div>
		</details>
		<div class="group">
			<div class="title"><span>透明度</span><span data-role="opacity-value"></span></div>
			<input class="slider" type="range" min="5" max="100" step="1" data-role="opacity">
		</div>
		<div class="group">
			<div class="title"><span>图片暗度</span><span data-role="dim-value"></span></div>
			<input class="slider" type="range" min="0" max="90" step="1" data-role="dim">
		</div>
		<div class="note" data-role="note"></div>
	</div>
</div>`;

			const $ = (role) => shadow.querySelector(`[data-role="${role}"]`);
			const presetRow = $("presets");
			const desktopRow = $("desktop-row");
			const opacityInput = $("opacity");
			const dimInput = $("dim");
			const fileInput = $("file");
			const note = $("note");
			const panel = shadow.querySelector(".panel");
			shadow.querySelector(".trigger").addEventListener("click", () => {
				panel.hidden = !panel.hidden;
			});

			// Close on outside click and on Escape, so the trigger is not the
			// only way out. Capture phase: the app's own handlers must not stop it.
			const closeOnOutside = (event) => {
				if (panel.hidden) return;
				if (event.composedPath().includes(host)) return;
				panel.hidden = true;
			};
			const closeOnEscape = (event) => {
				if (event.key === "Escape" && !panel.hidden) panel.hidden = true;
			};
			document.addEventListener("pointerdown", closeOnOutside, true);
			document.addEventListener("keydown", closeOnEscape, true);
			// Coming back to the window is the moment the user is most likely to
			// notice a new desktop wallpaper, so check before the next tick.
			const refreshOnFocus = () => {
				if (state.preset === DESKTOP_ID) void refreshDesktop();
			};
			window.addEventListener("focus", refreshOnFocus);

			opacityInput.addEventListener("input", () => update({ opacity: Number(opacityInput.value) }));
			dimInput.addEventListener("input", () => update({ dim: Number(dimInput.value) / 100 }));
			for (const button of shadow.querySelectorAll("[data-fit]")) {
				button.addEventListener("click", () => update({ fit: button.dataset.fit }));
			}
			$("import").addEventListener("click", () => fileInput.click());
			fileInput.addEventListener("change", async () => {
				const file = fileInput.files?.[0];
				fileInput.value = "";
				if (file) await importFile(file);
			});

			/** Bundled (minus hidden) + imported: the chips row. */
			function list() {
				return [...BUNDLED.filter((item) => !hidden.has(item.id)), ...customs];
			}

			/** Everything selectable, including the desktop entry (for the sheet). */
			function all() {
				return [...list(), ...(desktopEntry ? [desktopEntry] : [])];
			}

			function choiceButton(option) {
				const button = document.createElement("button");
				button.type = "button";
				button.className = "choice";
				button.textContent = option.label;
				button.title = option.hint ?? option.label;
				button.dataset.preset = option.id;
				button.addEventListener("click", () => {
					if (option.pending) {
						void selectDesktop();
						return;
					}
					// Click applies, clicking the active one again turns it off.
					update({ preset: state.preset === option.id ? "off" : option.id });
				});
				return button;
			}

			function renderPresets() {
				presetRow.textContent = "";

				for (const item of list()) {
					const label = item.kind === "video" ? `▶ ${item.label}` : item.label;
					const button = choiceButton({ id: item.id, label });
					// Imported entries are deleted, bundled ones are hidden
					// (restorable from the link below).
					const chip = document.createElement("span");
					chip.className = "chip";
					const del = document.createElement("button");
					del.type = "button";
					del.className = "del";
					del.textContent = "×";
					del.title = item.id.startsWith("c:") ? "删除这个壁纸" : "从列表移除（可恢复）";
					del.addEventListener("click", (event) => {
						event.stopPropagation();
						void removeChoice(item.id);
					});
					chip.append(button, del);
					presetRow.appendChild(chip);
				}
				presetRow.appendChild(choiceButton({ id: "off", label: "关" }));

				// The desktop wallpaper is a live read, not a stored file: it
				// gets its own row instead of sitting among the wallpapers.
				desktopRow.textContent = "";
				desktopRow.appendChild(
					choiceButton({
						id: DESKTOP_ID,
						label: "跟随桌面",
						hint: "读取当前系统桌面壁纸",
						pending: !desktopEntry,
					}),
				);

				if (hidden.size > 0) {
					const restore = document.createElement("button");
					restore.type = "button";
					restore.className = "restore";
					restore.textContent = `恢复内置壁纸（${hidden.size}）`;
					restore.addEventListener("click", () => {
						hidden = new Set();
						update({ hidden: [] });
					});
					presetRow.appendChild(restore);
				}
				markPreset();
			}

			function markPreset() {
				for (const element of shadow.querySelectorAll("[data-preset]")) {
					element.setAttribute("aria-pressed", String(element.dataset.preset === state.preset));
				}
			}

			/** Delete an import, or hide a bundled choice. */
			async function removeChoice(id) {
				if (!id.startsWith("c:")) {
					hidden.add(id);
					update({ hidden: [...hidden] });
					if (state.preset === id) update({ preset: "off" });
					return;
				}
				try {
					const stored = (await idbGet(CUSTOM_KEY)) ?? [];
					const next = stored.filter((item) => item.id !== id);
					await idbSet(CUSTOM_KEY, next);
					const gone = customs.find((item) => item.id === id);
					if (gone?.kind === "video") URL.revokeObjectURL(gone.url);
					records = next;
					customs = next.map(hydrate);
					renderPresets();
					if (state.preset === id) update({ preset: "off" });
					else render();
				} catch (error) {
					console.warn("[dsh-wallpaper] delete failed", error);
				}
			}

			/**
			 * Read the host's current desktop wallpaper.
			 * With `force` it always fetches; otherwise it sends the last ETag
			 * and a 304 means "nothing changed", so polling stays cheap.
			 */
			async function refreshDesktop(force = false) {
				try {
					const headers = {};
					if (!force && desktopEtag) headers["if-none-match"] = desktopEtag;
					const response = await fetch(DESKTOP_ROUTE, {
						credentials: "include",
						cache: "no-store",
						headers,
					});
					if (response.status === 304) return true;
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const blob = await response.blob();
					if (!blob.size) throw new Error("empty wallpaper");
					desktopEtag = response.headers.get("etag") ?? undefined;
					if (desktopEntry) URL.revokeObjectURL(desktopEntry.url);
					desktopEntry = { id: DESKTOP_ID, label: "跟随桌面", kind: "image", url: URL.createObjectURL(blob) };
					renderPresets();
					render();
					note.textContent = "";
					return true;
				} catch (error) {
					console.warn("[dsh-wallpaper] desktop wallpaper unavailable", error);
					note.textContent = "读不到桌面壁纸（Host 路由没注册或系统没有壁纸）";
					return false;
				}
			}

			/** Read the desktop wallpaper now and select it. */
			async function selectDesktop() {
				if (await refreshDesktop(true)) update({ preset: DESKTOP_ID });
			}

			/**
			 * Poll only while "follow the desktop" is the active wallpaper, so a
			 * rotating desktop slideshow shows up here within POLL_MS.
			 */
			function syncDesktopPolling() {
				const wanted = state.preset === DESKTOP_ID;
				if (wanted && desktopTimer === undefined) {
					desktopTimer = setInterval(() => void refreshDesktop(), POLL_MS);
				} else if (!wanted && desktopTimer !== undefined) {
					clearInterval(desktopTimer);
					desktopTimer = undefined;
				}
			}

			/** Show or hide the video layer for the current preset. */
			function syncVideo(entry) {
				if (!entry || entry.kind !== "video") {
					video.pause();
					video.removeAttribute("src");
					video.load();
					video.style.display = "none";
					scrim.style.display = "none";
					return;
				}
				if (video.src !== entry.url) video.src = entry.url;
				video.style.objectFit = state.fit === "contain" ? "contain" : "cover";
				video.style.display = "block";
				scrim.style.display = "block";
				scrim.style.background = `rgba(0,0,0,${state.dim})`;
				video.play().catch(() => {
					note.textContent = "视频自动播放被拦，点一下页面再试";
				});
			}

			function render() {
				const images = all();
				const entry = images.find((item) => item.id === state.preset);
				sheet.textContent = cssFor(state, images);
				syncVideo(entry);
				markPreset();
				for (const button of shadow.querySelectorAll("[data-fit]")) {
					button.setAttribute("aria-pressed", String(button.dataset.fit === state.fit));
				}
				$("fit-value").textContent = state.fit === "contain" ? "适应" : "填充";
				opacityInput.value = String(state.opacity);
				dimInput.value = String(Math.round(state.dim * 100));
				$("opacity-value").textContent = `${state.opacity}%`;
				$("dim-value").textContent = `${Math.round(state.dim * 100)}%`;
				if (entry?.kind === "video") note.textContent = `视频：${entry.label}`;
				else if (entry) note.textContent = "";
				syncDesktopPolling();
			}

			function update(patch) {
				Object.assign(state, patch);
				saveState(state);
				if ("hidden" in patch) renderPresets();
				render();
			}

			async function importFile(file) {
				try {
					const isVideo =
						file.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(file.name);
					if (isVideo) {
						if (file.size > MAX_VIDEO_BYTES) {
							note.textContent = `视频太大（${(file.size / 1048576).toFixed(0)} MB），上限 256 MB`;
							return;
						}
						// Keep the file as a Blob: base64 would inflate it by a third.
						await persist({ id: `c:${Date.now()}`, label: shortName(file.name), kind: "video", blob: file });
					} else {
						const url = await toDataUrl(file);
						await persist({ id: `c:${Date.now()}`, label: shortName(file.name), kind: "image", url });
					}
				} catch (error) {
					console.warn("[dsh-wallpaper] import failed", error);
					note.textContent = "导入失败，换个文件试试";
				}
			}

			async function persist(entry) {
				const stored = (await idbGet(CUSTOM_KEY).catch(() => null)) ?? [];
				const next = [...stored.slice(-(MAX_IMPORTS - 1)), entry];
				await idbSet(CUSTOM_KEY, next);
				for (const item of customs) {
					if (item.kind === "video") URL.revokeObjectURL(item.url);
				}
				records = next;
				customs = next.map(hydrate);
				renderPresets();
				update({ preset: entry.id });
			}

			function shortName(name) {
				const trimmed = String(name ?? "").replace(/\.[^.]+$/, "");
				return trimmed.length > 12 ? `${trimmed.slice(0, 11)}…` : trimmed || "导入";
			}

			/** Read an image file, downscale to MAX_SIDE and re-encode as JPEG. */
			async function toDataUrl(file) {
				const bitmap = await createImageBitmap(file);
				const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
				const canvas = document.createElement("canvas");
				canvas.width = Math.round(bitmap.width * scale);
				canvas.height = Math.round(bitmap.height * scale);
				canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
				bitmap.close?.();
				return canvas.toDataURL("image/jpeg", 0.85);
			}

			// First paint uses the bundled wallpapers so the canvas is never blank.
			renderPresets();
			render();
			(async () => {
				try {
					records = (await idbGet(CUSTOM_KEY)) ?? [];
				} catch {
					records = [];
				}
				customs = records.map(hydrate);
				renderPresets();
				render();
				if (state.preset === DESKTOP_ID) void refreshDesktop(true);
			})();

			return () => {
				if (desktopTimer !== undefined) clearInterval(desktopTimer);
				window.removeEventListener("focus", refreshOnFocus);
				document.removeEventListener("pointerdown", closeOnOutside, true);
				document.removeEventListener("keydown", closeOnEscape, true);
				video.pause();
				video.removeAttribute("src");
				video.remove();
				scrim.remove();
				host.remove();
				sheet.remove();
			};
		}

		return {
			/** Returns a teardown so uninstalling the bundle restores the app. */
			apply() {
				return mount();
			},
		};
	},
});
