/* 弹窗界面：四个按钮 + 结果列表 */
const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const buttons = Array.from(document.querySelectorAll("button"));

function setBusy(msg) {
  statusEl.innerHTML = '<span class="spin"></span> ' + msg;
  buttons.forEach((b) => (b.disabled = true));
}
function setStatus(msg) {
  statusEl.textContent = msg;
  buttons.forEach((b) => (b.disabled = false));
}

function render(links) {
  listEl.textContent = "";
  links.forEach((url, i) => {
    const row = document.createElement("div");
    row.className = "row";

    const a = document.createElement("a");
    a.href = url;
    a.textContent = url;
    a.title = url;
    a.target = "_blank";
    a.rel = "noreferrer";
    row.appendChild(a);

    const copy = document.createElement("button");
    copy.className = "mini";
    copy.textContent = "复制";
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url); copy.textContent = "已复制"; }
      catch (e) { copy.textContent = "失败"; }
      setTimeout(() => (copy.textContent = "复制"), 1500);
    };
    row.appendChild(copy);

    if (i === 0) {
      const tag = document.createElement("span");
      tag.textContent = "首个";
      tag.style.cssText = "font-size:11px;color:#1a7f37";
      row.appendChild(tag);
    }
    listEl.appendChild(row);
  });
}

async function ask(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setStatus("找不到当前标签页");
  if (/^(chrome|edge|about|devtools):/.test(tab.url || "") && type !== "clipboard") {
    return setStatus("这个页面上不能操作（浏览器内部页面）");
  }
  setBusy("处理中…");
  try {
    const res = await chrome.runtime.sendMessage({ type, tabId: tab.id });
    if (res && res.links && res.links.length) {
      render(res.links);
      try { await navigator.clipboard.writeText(res.links[0]); } catch (e) {}
      setStatus(`找到 ${res.links.length} 条，第 1 条已复制`);
    } else {
      setStatus((res && res.error) || "没找到二维码");
    }
  } catch (e) {
    setStatus("出错：" + (e.message || e));
  }
}

/* 框选/整页扫描要看到页面本身，先把请求发出去再关弹窗（立刻关会掐掉这条消息） */
function fireAndClose(type) {
  chrome.runtime.sendMessage({ type }).catch(() => {});
  setTimeout(() => window.close(), 150);
}

document.getElementById("scan").onclick = () => ask("scan-page");
document.getElementById("pick").onclick = () => fireAndClose("pick");
document.getElementById("full").onclick = () => fireAndClose("fullpage");
document.getElementById("clip").onclick = () => ask("clipboard");
