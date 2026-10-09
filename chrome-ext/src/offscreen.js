/* offscreen 页面：Service Worker 里没有 document，剪贴板图片只能在这里读 */

async function readClipboardImage() {
  // 优先走异步剪贴板 API（需要 document 有焦点，offscreen 页面满足）
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(bmp, 0, 0);
        bmp.close && bmp.close();
        const d = g.getImageData(0, 0, c.width, c.height);
        return { data: Array.from(d.data), width: d.width, height: d.height };
      }
    } catch (e) {
      return { error: "读剪贴板失败：" + (e.message || e) };
    }
    return { error: null, width: 0, height: 0 };
  }
  return { error: "当前环境不支持读剪贴板图片" };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "offscreen-clipboard") {
    readClipboardImage().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
    return true;
  }
});
