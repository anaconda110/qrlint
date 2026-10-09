/* 全部结果页：从 ?d= 里取链接列表渲染 */
const params = new URLSearchParams(location.search);
let links = [];
try { links = JSON.parse(params.get("d") || "[]"); } catch (e) { links = []; }

const listEl = document.getElementById("list");

links.forEach((url, i) => {
  const row = document.createElement("div");
  row.className = "row";

  const n = document.createElement("span");
  n.className = "n";
  n.textContent = String(i + 1);
  row.appendChild(n);

  const a = document.createElement("a");
  a.href = url;
  a.textContent = url;
  a.title = url;
  a.target = "_blank";
  a.rel = "noreferrer";
  row.appendChild(a);

  const copy = document.createElement("button");
  copy.textContent = "复制";
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url); copy.textContent = "已复制"; }
    catch (e) { copy.textContent = "失败"; }
    setTimeout(() => (copy.textContent = "复制"), 1500);
  };
  row.appendChild(copy);

  listEl.appendChild(row);
});

if (!links.length) {
  listEl.textContent = "没有结果。";
}
