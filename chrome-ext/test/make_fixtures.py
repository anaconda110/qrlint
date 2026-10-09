#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重新生成 test/fixtures.js（浏览器自检用的用例图，全部内联成 data URL）。

依赖: pip install pillow qrcode numpy
用法: python test/make_fixtures.py      # 在 chrome-ext 目录下运行
"""
import base64
import io
import json
import os

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFilter

TARGET = "https://pan.quark.cn/s/000000000000"
T2 = "https://pan.quark.cn/s/aaa111"
T3 = "https://pan.baidu.com/s/1bbb222"


def qr(text, box=10, border=4):
    q = qrcode.QRCode(box_size=box, border=border)
    q.add_data(text)
    q.make(fit=True)
    return q.make_image(fill_color="black", back_color="white").convert("RGB")


def data_url(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def build():
    cases = []

    def add(name, im, expect, note):
        cases.append({"name": name, "img": im.convert("RGB"), "expect": expect, "note": note})

    add("clean", qr(TARGET), [TARGET], "标准二维码")
    add("small", qr(TARGET, box=4).resize((92, 92), Image.LANCZOS), [TARGET], "92px 小图")
    add("tiny", qr(TARGET, box=3).resize((64, 64), Image.LANCZOS), [TARGET], "64px 极小图")

    rot = qr(TARGET).rotate(13, expand=True, fillcolor=(255, 255, 255), resample=Image.BICUBIC)
    noisy = np.asarray(rot).astype(np.int16) + np.random.normal(0, 20, (rot.height, rot.width, 3))
    add("rot_noise", Image.fromarray(np.clip(noisy, 0, 255).astype("uint8")), [TARGET], "旋转 13° + 噪声")
    add("blur", rot.filter(ImageFilter.GaussianBlur(1.7)), [TARGET], "高斯模糊 1.7px")

    gray = qr(TARGET).convert("L").point(lambda v: 90 if v < 128 else 175).convert("RGB")
    add("lowcontrast", gray, [TARGET], "灰底灰码（低对比）")
    add("inverted", Image.eval(qr(TARGET), lambda v: 255 - v), [TARGET], "反色码")

    a1, a2 = qr(T2, box=6), qr(T3, box=6)
    two = Image.new("RGB", (a1.width + a2.width + 20, max(a1.height, a2.height)), "white")
    two.paste(a1, (0, 0))
    two.paste(a2, (a1.width + 20, 0))
    add("twocodes", two, [T2, T3], "一张图两个码")

    shot = Image.new("RGB", (700, 420), (235, 238, 242))
    d = ImageDraw.Draw(shot)
    for i in range(0, 700, 7):
        d.line([(i, 0), (i, 420)], fill=(220, 224, 230))
    shot.paste(qr(TARGET, box=5), (60, 40))
    add("screenshot", shot, [TARGET], "网页截图风格底图上的码")

    big = Image.new("RGB", (1600, 1100), "white")
    d = ImageDraw.Draw(big)
    for i in range(0, 1600, 40):
        d.line([(i, 0), (i, 1100)], fill=(238, 240, 244))
    big.paste(qr(TARGET, box=4), (1180, 760))
    big.paste(qr(T2, box=6), (120, 130))
    add("bigpage", big, [T2, TARGET], "1600x1100 大图里两个小码")

    # 整页扫描拼出来的长条（这里用 4 屏高的页面模拟）
    tall = Image.new("RGB", (1280, 648 * 4), "white")
    tall.paste(qr(T2), (200, 300))
    tall.paste(qr(T3), (600, 1700))
    add("tallpage", tall, [T2, T3], "1280x2592 长图（整页扫描拼接）")

    items = [{"name": c["name"], "expect": c["expect"], "note": c["note"], "url": data_url(c["img"])}
             for c in cases]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures.js")
    with open(out, "w", encoding="utf-8") as f:
        f.write("window.QR_FIXTURES = " + json.dumps(items, ensure_ascii=False) + ";\n")
    print(out, round(os.path.getsize(out) / 1024), "KB,", len(items), "cases")


if __name__ == "__main__":
    build()
