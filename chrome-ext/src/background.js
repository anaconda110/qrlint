/* QRLink 后台：右键菜单 + 取图 + 截图拼接 + 结果投递
 *
 * 设计要点（有意为之，别改回去）：
 *  - 不申请 <all_urls>：跨域图片直接 fetch 需要主机权限，于是改成
 *      ① 把 jsQR/decode.js 注入页面隔离世界，用页面自己的 canvas 取像素解码（同源图通吃）
 *      ② 读不出像素的（跨域污染 canvas、CSS 背景图、<canvas>）走 captureVisibleTab 截屏裁剪
 *    两条路都不需要额外权限，只靠 activeTab + scripting。
 *  - captureVisibleTab 的第一个参数是 windowId，不是 tabId，必须先从 tabs.get 拿 windowId。
 */
importScripts("../vendor/jsqr.js", "decode.js");

const MENU_PARENT = "qrlink-root";
const MENU_SCAN = "qrlink-scan-page";
const MENU_PICK = "qrlink-pick";
const MENU_FULL = "qrlink-fullpage";
const MENU_CLIP = "qrlink-clip";
const MENU_IMG = "qrlink-from-image";

const SCAN_BUDGET_MS = 2500;    // 单张图在页内解码的时间预算
const MAX_IMAGES = 40;         // 每次扫描最多处理多少张图
const MAX_TILES = 24;          // 整页扫描的截图上限
const TILE_SETTLE_MS = 550;    // captureVisibleTab 有 2 次/秒的限流
const MAX_STITCH_PIXELS = 26e6;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    const mk = (opts) => chrome.contextMenus.create(opts);
    mk({ id: MENU_PARENT, title: "二维码取链", contexts: ["all"] });
    mk({ id: MENU_SCAN, parentId: MENU_PARENT, title: "扫描本页所有图片", contexts: ["page", "frame"] });
    mk({ id: MENU_PICK, parentId: MENU_PARENT, title: "框选页面上的二维码…", contexts: ["page", "frame"] });
    mk({ id: MENU_FULL, parentId: MENU_PARENT, title: "整页扫描（自动滚动）", contexts: ["page", "frame"] });
    mk({ id: MENU_CLIP, parentId: MENU_PARENT, title: "解剪贴板里的图片", contexts: ["page", "frame", "action"] });
    mk({ id: MENU_IMG, parentId: MENU_PARENT, title: "从这张图片解二维码", contexts: ["image"] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab && tab.id;
  try {
    if (info.menuItemId === MENU_SCAN) return await run(tabId, scanPage(tabId), "扫描本页图片");
    if (info.menuItemId === MENU_PICK) return await run(tabId, pickAndDecode(tabId), "框选区域");
    if (info.menuItemId === MENU_FULL) return await run(tabId, fullPageScan(tabId), "整页扫描");
    if (info.menuItemId === MENU_CLIP) return await run(tabId, decodeClipboard(), "剪贴板图片");
    if (info.menuItemId === MENU_IMG) return await run(tabId, scanPage(tabId, info.srcUrl), "页面图片");
  } catch (e) {
    report(tabId, [], String((e && e.message) || e));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // 弹窗发来的消息 sender.tab 是空的，优先用消息里的 tabId，再退回当前活动标签页
      const tabId = msg.tabId || (sender.tab && sender.tab.id) || (await activeTabId());
      let res;
      if (msg.type === "scan-page") res = await scanPage(tabId);
      else if (msg.type === "pick") res = await pickAndDecode(tabId);
      else if (msg.type === "fullpage") res = await fullPageScan(tabId);
      else if (msg.type === "clipboard") res = await decodeClipboard();
      else if (msg.type === "capture") res = await decodeViewport(tabId);
      else throw new Error("未知请求");
      sendResponse({ ok: res.links.length > 0, links: res.links, error: res.error || null });
    } catch (e) {
      sendResponse({ ok: false, links: [], error: String((e && e.message) || e) });
    }
  })();
  return true;   // 异步应答
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && tab.id;
}

/* ------------------------------------------------------------ 统一投递 */

async function run(tabId, promise, label) {
  setBadge("…", "#666");
  const res = await promise;
  report(tabId, res.links, res.error, label);
  return res;
}

async function report(tabId, links, error) {
  if (links && links.length) {
    setBadge(String(links.length), "#1a7f37");
    try { await navigator.clipboard.writeText(links[0]); } catch (e) { /* 无痕模式等场景会失败，忽略 */ }
    notify("二维码取链：已复制第 1 条", links[0] + (links.length > 1 ? `\n（共 ${links.length} 条，已另开标签页列出全部）` : ""));
    if (links.length > 1) {
      const url = chrome.runtime.getURL("src/results.html") + "?d=" + encodeURIComponent(JSON.stringify(links));
      try { await chrome.tabs.create({ url, active: false }); } catch (e) {}
    }
  } else {
    setBadge("0", "#b00");
    notify("二维码取链：没找到二维码", error || "换个更清楚的角度或更大的图片再试。");
  }
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: color || "#1a7f37" });
    chrome.action.setBadgeText({ text: text || "" });
    if (text) setTimeout(() => { try { chrome.action.setBadgeText({ text: "" }); } catch (e) {} }, 6000);
  } catch (e) {}
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: title,
      message: message || ""
    });
  } catch (e) {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ============================================================ 页面内解码 */

/* 注入到页面隔离世界：把能读到的图片就地解码，读不到的登记成矩形交给截屏兜底 */
function inPageScan(opts) {
  const D = self.QRLinkDecode;
  if (!D) return { error: "解码库没注入成功" };
  const links = [];
  const rects = [];
  const vw = innerWidth, vh = innerHeight;
  const only = opts && opts.onlyUrl;

  const decodeDrawable = (drawable, w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(drawable, 0, 0, w, h);
    const id = g.getImageData(0, 0, w, h);   // 跨域污染的图会在这里抛错
    return D.fromImageDataLike(id, { budgetMs: opts.budgetMs }).links;
  };

  const visible = (r) => r.width >= 60 && r.height >= 60 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;

  const imgs = Array.from(document.images);
  for (const img of imgs) {
    if (links.length >= 40) break;
    const src = img.currentSrc || img.src || "";
    if (only && src !== only) continue;
    if (img.naturalWidth < 60 || img.naturalHeight < 60) continue;
    const r = img.getBoundingClientRect();
    try {
      links.push(...decodeDrawable(img, img.naturalWidth, img.naturalHeight));
    } catch (e) {
      if (visible(r)) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });   // 跨域污染的图走截屏
    }
  }

  // <canvas> 与 CSS 背景图只能截屏
  for (const c of Array.from(document.querySelectorAll("canvas"))) {
    if (rects.length >= 12) break;
    const r = c.getBoundingClientRect();
    if (visible(r) && r.width >= 100 && r.height >= 100) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  if (rects.length < 12) {
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (rects.length >= 12) break;
      let bg = "";
      try { bg = getComputedStyle(el).backgroundImage || ""; } catch (e) { continue; }
      if (!bg || bg === "none") continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 120 && r.height >= 120 && visible(r)) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
  }
  return { links: D.uniq(links), rects };
}

async function injectLibs(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["vendor/jsqr.js", "src/decode.js"]
  });
}

/* 扫描页面上所有图片 */
async function scanPage(tabId, onlyUrl) {
  if (!tabId) throw new Error("找不到标签页");
  await injectLibs(tabId);
  const [inj] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inPageScan,
    args: [{ onlyUrl: onlyUrl || null, budgetMs: SCAN_BUDGET_MS }]
  });
  const r = (inj && inj.result) || {};
  let links = (r.links || []).slice();
  let error = r.error || null;

  const rects = (r.rects || []).slice(0, MAX_IMAGES).slice(0, 10);
  if (rects.length) {
    try {
      const shot = await decodeVisibleRects(tabId, rects);
      links.push(...shot.links);
      if (!links.length && shot.error) error = shot.error;
    } catch (e) {
      if (!links.length) error = String((e && e.message) || e);
    }
  }
  links = QRLinkDecode.uniq(links);
  return { links, error: links.length ? null : (error || "页面上没找到二维码") };
}

/* ============================================================ 截屏兜底 */

/* 取当前视口截图（注意第一个参数是 windowId） */
async function captureViewport(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function bitmapOfDataUrl(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  try {
    return await createImageBitmap(blob);
  } catch (e) {
    // 老一点的实现不认 blob，退回 <img>（这里在 SW 里不行，所以再退一步报错）
    throw new Error("截图解析失败：" + ((e && e.message) || e));
  }
}

/* 从当前视口截图里裁剪若干矩形并解码（canvas / 跨域图片 / 框选都用这条） */
async function decodeVisibleRects(tabId, rects) {
  const dataUrl = await captureViewport(tabId);
  const bmp = await bitmapOfDataUrl(dataUrl);
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: () => innerWidth });
  const cssWidth = (inj && inj.result) || bmp.width;
  const dpr = bmp.width / cssWidth;

  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();

  const links = [];
  for (const r of rects.slice(0, 12)) {
    const pad = 4;
    const x = Math.max(0, Math.floor(r.x * dpr) - pad);
    const y = Math.max(0, Math.floor(r.y * dpr) - pad);
    const w = Math.min(canvas.width - x, Math.ceil(r.w * dpr) + pad * 2);
    const h = Math.min(canvas.height - y, Math.ceil(r.h * dpr) + pad * 2);
    if (w < 24 || h < 24) continue;
    try {
      const id = g.getImageData(x, y, w, h);
      links.push(...QRLinkDecode.fromImageDataLike(id).links);
    } catch (e) {}
  }
  return { links: QRLinkDecode.uniq(links), error: links.length ? null : "这块区域里没认出二维码" };
}

/* 框选一块区域 */
async function pickAndDecode(tabId) {
  if (!tabId) throw new Error("找不到标签页");
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: pickRectInPage });
  const rect = inj && inj.result;
  if (!rect) return { links: [], error: "已取消" };
  return decodeVisibleRects(tabId, [rect]);
}

/* 注入到页面：高亮鼠标下的元素，点一下确认，Esc 取消 */
function pickRectInPage() {
  return new Promise((resolve) => {
    const old = document.getElementById("__qrlink_overlay__");
    if (old) old.remove();
    const box = document.createElement("div");
    box.id = "__qrlink_overlay__";
    Object.assign(box.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair",
      background: "rgba(0,0,0,0.06)", pointerEvents: "auto"
    });
    const mark = document.createElement("div");
    Object.assign(mark.style, {
      position: "fixed", border: "2px solid #00e0ff", background: "rgba(0,224,255,0.15)",
      pointerEvents: "none", display: "none", zIndex: "2147483647"
    });
    const tip = document.createElement("div");
    Object.assign(tip.style, {
      position: "fixed", left: "50%", top: "12px", transform: "translateX(-50%)",
      background: "#111", color: "#fff", font: "13px/1.6 system-ui,sans-serif",
      padding: "4px 12px", borderRadius: "14px", pointerEvents: "none", zIndex: "2147483647"
    });
    tip.textContent = "移到二维码上点一下确认，Esc 取消";
    box.appendChild(mark);
    box.appendChild(tip);
    document.documentElement.appendChild(box);

    let target = null;
    const done = (val) => {
      box.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); done(null); } };

    box.addEventListener("mousemove", (e) => {
      box.style.pointerEvents = "none";
      const el = document.elementFromPoint(e.clientX, e.clientY);
      box.style.pointerEvents = "auto";
      if (!el || el === box || el === mark || el === tip) return;
      target = el;
      const r = el.getBoundingClientRect();
      Object.assign(mark.style, {
        display: "block", left: r.left + "px", top: r.top + "px",
        width: r.width + "px", height: r.height + "px"
      });
    });
    box.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!target) return done(null);
      const r = target.getBoundingClientRect();
      done({ x: r.left, y: r.top, w: r.width, h: r.height });
    }, true);
    document.addEventListener("keydown", onKey, true);
  });
}

/* 整页扫描：逐屏滚动截图，在内存里拼成一张长图再解 */
async function fullPageScan(tabId) {
  if (!tabId) throw new Error("找不到标签页");
  const [m0] = await chrome.scripting.executeScript({ target: { tabId }, func: pageMetricsInPage });
  const m = m0 && m0.result;
  if (!m) throw new Error("读不到页面尺寸");
  const dpr = m.dpr;
  const step = Math.max(120, Math.floor(m.vh * 0.9));
  const want = Math.min(MAX_TILES, Math.max(1, Math.ceil(m.scrollHeight / step)));

  const shots = [];
  const errors = [];
  let i = 0, guard = 0;
  while (i < want) {
    const y = Math.min(i * step, Math.max(0, m.scrollHeight - m.vh));
    await chrome.scripting.executeScript({ target: { tabId }, func: (yy) => scrollTo(0, yy), args: [y] });
    await sleep(TILE_SETTLE_MS);
    try {
      shots.push({ y, dataUrl: await captureViewport(tabId) });
      i++;
    } catch (e) {
      const msg = String((e && e.message) || e);
      errors.push(msg);
      if (++guard > 6) break;                 // 连续失败就别再试了
      await sleep(900);                        // 多半是 MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND，等一下重试
    }
  }
  await chrome.scripting.executeScript({ target: { tabId }, func: restorePageInPage, args: [m.y] });
  if (!shots.length) return { links: [], error: errors[0] || "截图失败" };

  const bitmaps = [];
  for (const s of shots) bitmaps.push(await bitmapOfDataUrl(s.dataUrl));
  const w0 = bitmaps[0].width, h0 = bitmaps[0].height;

  let stitched = Math.max(h0, Math.round(m.scrollHeight * dpr));
  stitched = Math.min(stitched, h0 + step * dpr * shots.length);
  let canvas = new OffscreenCanvas(w0, stitched);
  if (w0 * stitched > MAX_STITCH_PIXELS) {           // 太大了就先缩小，二维码仍能解出
    const k = Math.sqrt(MAX_STITCH_PIXELS / (w0 * stitched));
    canvas = new OffscreenCanvas(Math.round(w0 * k), Math.round(stitched * k));
  }
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  const scale = canvas.width / w0;
  bitmaps.forEach((b, idx) => {
    const y = Math.min(canvas.height - Math.round(b.height * scale),
                       Math.max(0, Math.round(shots[idx].y * dpr * scale)));
    g.drawImage(b, 0, y, Math.round(b.width * scale), Math.round(b.height * scale));
    if (b.close) b.close();
  });

  const id = g.getImageData(0, 0, canvas.width, canvas.height);
  const res = QRLinkDecode.fromImageDataLike(id, { budgetMs: 12000 });
  return { links: res.links, error: res.links.length ? null : (errors[0] || "整页扫描没找到二维码") };
}

/* 注入到页面：滚动前隐藏固定/粘性元素，避免每屏都重复一遍页头 */
function pageMetricsInPage() {
  const hidden = [];
  document.querySelectorAll("body *").forEach((el) => {
    let cs;
    try { cs = getComputedStyle(el); } catch (e) { return; }
    if (cs.position === "fixed" || cs.position === "sticky") {
      hidden.push({ el, vis: el.style.visibility });
      el.style.visibility = "hidden";
    }
  });
  window.__qrlinkHidden = hidden;
  return {
    vh: innerHeight,
    vw: innerWidth,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    dpr: devicePixelRatio || 1,
    y: scrollY
  };
}

function restorePageInPage(prevScroll) {
  const hidden = window.__qrlinkHidden || [];
  hidden.forEach((h) => { try { h.el.style.visibility = h.vis || ""; } catch (e) {} });
  window.__qrlinkHidden = null;
  scrollTo(0, prevScroll);
}

/* 当前视口整屏解一遍 */
async function decodeViewport(tabId) {
  if (!tabId) throw new Error("找不到标签页");
  const bmp = await bitmapOfDataUrl(await captureViewport(tabId));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const res = QRLinkDecode.fromImageDataLike(g.getImageData(0, 0, canvas.width, canvas.height));
  return { links: res.links, error: res.links.length ? null : "当前屏幕里没找到二维码" };
}

/* ============================================================ 剪贴板 */

async function decodeClipboard() {
  await ensureOffscreen();
  const reply = await chrome.runtime.sendMessage({ type: "offscreen-clipboard" });
  if (!reply) return { links: [], error: "剪贴板读取无应答" };
  if (reply.error) return { links: [], error: reply.error };
  if (!reply.width) return { links: [], error: "剪贴板里没有图片" };
  const id = { data: new Uint8ClampedArray(reply.data), width: reply.width, height: reply.height };
  const res = QRLinkDecode.fromImageDataLike(id);
  return { links: res.links, error: res.links.length ? null : "剪贴板图片里没找到二维码" };
}

let offscreenReady = null;
function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: "src/offscreen.html",
        reasons: ["CLIPBOARD"],
        justification: "读取剪贴板里的图片内容用于解二维码"
      });
    } catch (e) {
      if (!String((e && e.message) || e).includes("Only a single offscreen")) throw e;
    }
  })();
  return offscreenReady;
}
