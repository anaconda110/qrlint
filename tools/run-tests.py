#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""跑一遍解码核心的全部用例（Node 端）。

用法（在仓库根目录）:  python -X utf8 tools/run-tests.py
"""
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXT = os.path.join(ROOT, "chrome-ext")

RUNNER = r"""
const fs = require("fs"), vm = require("vm");
const box = { console, Uint8ClampedArray, Math, Infinity, Error, Date };
box.self = box; box.globalThis = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync("vendor/jsqr.js", "utf8"), box, { filename: "jsqr" });
box.jsQR = box.self.jsQR || (box.module && box.module.exports);
vm.runInContext(fs.readFileSync("src/decode.js", "utf8"), box, { filename: "decode" });
const D = box.QRLinkDecode;
const meta = JSON.parse(fs.readFileSync(process.argv[2] + "/meta.json", "utf8"));
let bad = 0, worst = 0;
for (const [name, m] of Object.entries(meta)) {
  const id = { data: new Uint8ClampedArray(fs.readFileSync(`${process.argv[2]}/${name}.raw`)), width: m.w, height: m.h };
  const t0 = Date.now();
  const res = D.fromImageDataLike(id, { budgetMs: 12000 });
  const ms = Date.now() - t0;
  worst = Math.max(worst, ms);
  const hit = m.expect.every((w) => res.links.indexOf(w) >= 0);
  if (!hit) bad++;
  console.log(`${hit ? "PASS" : "FAIL"} ${name.padEnd(12)} ${String(m.w + "x" + m.h).padEnd(10)} ${String(ms).padStart(5)}ms  `
    + `${String(res.pass).padEnd(9)} n=${res.links.length}/${m.expect.length}`);
  if (!hit) console.log(`     expected ${m.expect.join(" | ")}\n     got      ${res.links.join(" | ")}`);
}
console.log(bad ? `\n${bad} case(s) failed` : `\nall ${Object.keys(meta).length} cases passed (worst ${worst}ms)`);
process.exit(bad ? 1 : 0);
"""


def main():
    from PIL import Image  # noqa: F401  (依赖检查)

    cases = json.loads(
        open(os.path.join(EXT, "test", "fixtures.js"), encoding="utf-8").read().split("= ", 1)[1].rstrip(";\n")
    )
    tmp = tempfile.mkdtemp(prefix="qrlink-test-")
    try:
        meta = {}
        for c in cases:
            raw = base64.b64decode(c["url"].split(",", 1)[1])
            im = Image.open(io.BytesIO(raw)).convert("RGBA")
            with open(os.path.join(tmp, c["name"] + ".raw"), "wb") as f:
                f.write(im.tobytes())
            meta[c["name"]] = {"w": im.width, "h": im.height, "expect": c["expect"]}
        with open(os.path.join(tmp, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f)

        runner = os.path.join(tmp, "run.js")
        with open(runner, "w", encoding="utf-8") as f:
            f.write(RUNNER)

        node = shutil.which("node")
        if not node:
            print("找不到 node，无法运行解码核心测试。", file=sys.stderr)
            return 2
        proc = subprocess.run([node, runner, tmp], cwd=EXT)
        return proc.returncode
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
