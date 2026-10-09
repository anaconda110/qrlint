#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""qrlink — 二维码取链小工具

从「剪贴板图片 / 图片文件 / 屏幕框选」里提取二维码内容，自动复制到剪贴板。

用法:
    pythonw qrlink.py                打开图形界面
    python  qrlink.py 图片.png ...   直接解码这些文件并把结果放进剪贴板
    python  qrlink.py --clip         读剪贴板图片, 打印文本结果 (脚本 / agent 用)
    python  qrlink.py --first 图.png 只打印第一个结果 (最省事)
"""

import os
import sys
import time
import hashlib
import queue
import threading


# ---------------------------------------------------------------- 解码核心

def _unique(items):
    out = []
    for it in items:
        it = (it or "").strip()
        if it and it not in out:
            out.append(it)
    return out


def _zxing(img):
    """zxing-cpp 主路径: 抗畸变、支持多码。"""
    try:
        import zxingcpp
    except ImportError:
        return []
    out = []
    try:
        for r in zxingcpp.read_barcodes(img):
            if getattr(r, "valid", True) and r.text:
                out.append(r.text)
    except Exception:
        return []
    return out


def _cv2_pass(gray):
    """OpenCV 兜底: 多尺度 + Otsu, 抓小图 / 低对比的码。"""
    try:
        import cv2
    except ImportError:
        return []
    out = []
    det = cv2.QRCodeDetector()
    for scale in (1, 2, 3):
        up = gray if scale == 1 else cv2.resize(
            gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        for thr in (None, "otsu"):
            x = up if thr is None else cv2.threshold(
                up, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
            try:
                data, _, _ = det.detectAndDecode(x)
                if data:
                    out.append(data)
                multi, _, _, _ = det.detectAndDecodeMulti(x)
                out.extend(multi or [])
            except Exception:
                pass
    return out


def decode_pil(img):
    """PIL.Image -> [链接, ...]"""
    import numpy as np
    rgb = img.convert("RGB")
    arr = np.asarray(rgb)[:, :, ::-1].copy()          # BGR, zxing 认这个
    gray = np.asarray(rgb.convert("L"))

    found = _unique(_zxing(arr))
    if not found:
        found = _unique(_zxing(gray))
    if not found:
        found = _unique(_cv2_pass(gray))
    return found


def decode_path(path):
    from PIL import Image
    with Image.open(path) as im:
        im.load()
        return decode_pil(im)


def clipboard_image():
    """返回 (PIL.Image 或 None, [文件路径]); 剪贴板里可能是位图也可能是文件。"""
    from PIL import ImageGrab
    for _ in range(4):            # 别的程序可能正占着剪贴板, 失败就稍等重试
        try:
            data = ImageGrab.grabclipboard()
        except Exception:
            time.sleep(0.15)
            continue
        if isinstance(data, list):
            return None, [p for p in data if isinstance(p, str)]
        if data is None:
            return None, []
        return data, []
    return None, []


# ---------------------------------------------------------------- 快捷键

def virtual_screen():
    """整个虚拟桌面 (多显示器) 的 (x, y, w, h)。"""
    try:
        import ctypes
        u = ctypes.windll.user32
        return (u.GetSystemMetrics(76), u.GetSystemMetrics(77),
                u.GetSystemMetrics(78), u.GetSystemMetrics(79))
    except Exception:
        return (0, 0, 1920, 1080)


def hotkey_thread(q):
    """后台线程注册全局热键 Ctrl+Alt+Q, 命中就往队列里塞事件。"""
    import ctypes
    import ctypes.wintypes as w
    u = ctypes.windll.user32
    MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_Q, WM_HOTKEY = 0x1, 0x2, 0x4000, 0x51, 0x0312
    if not u.RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_Q):
        q.put(("hotkey_fail", None))
        return
    q.put(("hotkey_ok", None))
    msg = w.MSG()
    while u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        if msg.message == WM_HOTKEY:
            q.put(("hotkey", None))


# ---------------------------------------------------------------- 图形界面

def run_gui(initial_files=()):
    import tkinter as tk
    from tkinter import filedialog, messagebox
    from PIL import ImageGrab

    q = queue.Queue()
    state = {"clip_hash": None}

    root = tk.Tk()
    root.title("二维码取链")
    root.geometry("620x360+120+120")
    root.attributes("-topmost", True)

    top = tk.Frame(root)
    top.pack(fill="x", padx=8, pady=(8, 4))
    txt = tk.Text(root, height=11, wrap="none", font=("Consolas", 10))
    txt.pack(fill="both", expand=True, padx=8)
    bar = tk.Frame(root)
    bar.pack(fill="x", padx=8, pady=4)
    status = tk.Label(root, anchor="w", fg="#555", text="就绪")
    status.pack(fill="x", padx=8, pady=(0, 8))

    def say(msg):
        status.config(text=msg)
        root.update_idletasks()

    def show(links, source, autopick=True):
        txt.delete("1.0", "end")
        for l in links:
            txt.insert("end", l + "\n")
        if links:
            if autopick:
                copy(links[0], quiet=True)
            say("%s：找到 %d 条，已复制第 1 条" % (source, len(links)))
        else:
            say("%s：没找到二维码" % source)

    def copy(text=None, quiet=False):
        text = text or txt.get("1.0", "end").strip()
        if not text:
            return
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        if not quiet:
            say("已复制：%s" % text.splitlines()[0][:70])

    def open_first(_=None):
        lines = [l.strip() for l in txt.get("1.0", "end").splitlines() if l.strip()]
        if not lines:
            return
        # 双击某行就打开那行, 否则打开第一条
        try:
            row = int(txt.index("@%d,%d" % (root.winfo_pointerx() - txt.winfo_rootx(),
                                            root.winfo_pointery() - txt.winfo_rooty())
                           ).split(".")[0])
        except Exception:
            row = 1
        target = lines[row - 1] if 1 <= row <= len(lines) else lines[0]
        import webbrowser
        webbrowser.open(target)

    def from_clip(silent=False):
        img, files = clipboard_image()
        if files:
            links = []
            for p in files:
                try:
                    links.extend(decode_path(p))
                except Exception as e:
                    say("读不了 %s: %s" % (os.path.basename(p), e))
            show(_unique(links), "剪贴板文件")
            return
        if img is None:
            if not silent:
                say("剪贴板里没有图片")
            return
        try:
            h = hashlib.md5(img.tobytes()).hexdigest()
        except Exception:
            h = None
        if silent and h and h == state["clip_hash"]:
            return
        state["clip_hash"] = h
        show(decode_pil(img), "剪贴板图片")

    def from_file():
        paths = filedialog.askopenfilenames(
            title="选择含二维码的图片",
            filetypes=[("图片", "*.png *.jpg *.jpeg *.bmp *.gif *.webp *.tif *.tiff"),
                       ("全部", "*.*")])
        if not paths:
            return
        links = []
        for p in paths:
            try:
                links.extend(decode_path(p))
            except Exception as e:
                say("读不了 %s: %s" % (os.path.basename(p), e))
        show(_unique(links), "图片文件")

    # --- 屏幕框选 ---
    def capture_region():
        root.withdraw()
        root.update()
        time.sleep(0.25)
        vx, vy, vw, vh = virtual_screen()
        ov = tk.Toplevel(root)
        ov.overrideredirect(True)
        ov.geometry("%dx%d+%d+%d" % (vw, vh, vx, vy))
        ov.attributes("-topmost", True)
        try:
            ov.attributes("-alpha", 0.35)
        except Exception:
            pass
        cv = tk.Canvas(ov, bg="#1a1a1a", cursor="crosshair", highlightthickness=0)
        cv.pack(fill="both", expand=True)
        cv.create_text(vw // 2, 30, fill="#fff", font=("Microsoft YaHei", 13),
                       text="拖框住二维码，Esc 取消")
        box = {}

        def press(e):
            box["x0"], box["y0"] = e.x, e.y
            box["rect"] = cv.create_rectangle(e.x, e.y, e.x, e.y, outline="#00e0ff", width=2)

        def drag(e):
            if "rect" in box:
                cv.coords(box["rect"], box["x0"], box["y0"], e.x, e.y)
                box["x1"], box["y1"] = e.x, e.y

        def release(_):
            ov.destroy()
            root.deiconify()
            root.lift()
            x0, y0 = box.get("x0"), box.get("y0")
            x1, y1 = box.get("x1", x0), box.get("y1", y0)
            if x0 is None or abs(x1 - x0) < 6 or abs(y1 - y0) < 6:
                say("已取消")
                return
            sx, sy = min(x0, x1) + vx, min(y0, y1) + vy
            ex, ey = max(x0, x1) + vx, max(y0, y1) + vy
            try:
                shot = ImageGrab.grab(all_screens=True)
                img = shot.crop((sx, sy, ex, ey))
                img.load()
            except Exception as e:
                say("截图失败: %s" % e)
                return
            links = decode_pil(img)
            if not links:                      # 一次没中, 放大再试一遍
                big = img.resize((img.width * 2, img.height * 2))
                links = decode_pil(big)
            show(links, "屏幕截取")

        def cancel(_=None):
            ov.destroy()
            root.deiconify()
            say("已取消")

        cv.bind("<ButtonPress-1>", press)
        cv.bind("<B1-Motion>", drag)
        cv.bind("<ButtonRelease-1>", release)
        ov.bind("<Escape>", cancel)
        ov.focus_force()

    def poll():
        while True:
            try:
                kind, _ = q.get_nowait()
            except queue.Empty:
                break
            if kind == "hotkey":
                capture_region()
            elif kind == "hotkey_ok":
                say("就绪 · 全局热键 Ctrl+Alt+Q 已启用")
            elif kind == "hotkey_fail":
                say("就绪 · 全局热键被占用，请用按钮或 Ctrl+Alt+Q 之外的方式")
        if watch.get():
            from_clip(silent=True)
        root.after(700, poll)

    tk.Button(top, text="读剪贴板 (Ctrl+V)", width=17,
              command=from_clip).pack(side="left")
    tk.Button(top, text="选图片…", width=11, command=from_file).pack(side="left", padx=4)
    tk.Button(top, text="屏幕框选 (Ctrl+Alt+Q)", width=20,
              command=capture_region).pack(side="left")
    watch = tk.IntVar(value=0)
    tk.Checkbutton(top, text="监听剪贴板", variable=watch).pack(side="left", padx=6)

    tk.Button(bar, text="复制全部", width=10,
              command=lambda: copy()).pack(side="left")
    tk.Button(bar, text="打开第一个", width=10, command=open_first).pack(side="left", padx=4)
    tk.Button(bar, text="清空", width=6,
              command=lambda: (txt.delete("1.0", "end"), say("就绪"))).pack(side="left")

    root.bind("<Control-v>", lambda e: from_clip())
    root.bind("<Control-V>", lambda e: from_clip())
    root.bind("<Escape>", lambda e: root.withdraw())
    txt.bind("<Double-Button-1>", open_first)

    threading.Thread(target=hotkey_thread, args=(q,), daemon=True).start()
    root.after(400, poll)
    if initial_files:
        links = []
        for p in initial_files:
            try:
                links.extend(decode_path(p))
            except Exception as e:
                say("读不了 %s: %s" % (os.path.basename(p), e))
        show(_unique(links), "图片文件")
    else:
        from_clip(silent=True)
    root.mainloop()


# ---------------------------------------------------------------- 命令行

def cli(paths, clip=False, first=False, copy=False):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    links = []
    if clip:
        img, files = clipboard_image()
        if files:
            for p in files:
                links.extend(decode_path(p))
        elif img is not None:
            links.extend(decode_pil(img))
    for p in paths:
        links.extend(decode_path(p))
    links = _unique(links)
    if first:
        links = links[:1]
    for l in links:
        print(l)
    if copy:
        put_clipboard(links[0] if links else "")
    return 0 if links else 1


def put_clipboard(text):
    """不依赖 tkinter 地写剪贴板: 用 clip.exe。"""
    if not text:
        return
    try:
        import subprocess
        subprocess.run("clip", input=text.encode("utf-16-le"),
                       shell=True, check=False)
    except Exception:
        pass


def main():
    args = [a for a in sys.argv[1:]]
    want_copy = "--copy" in args
    if "--clip" in args:
        return cli([], clip=True, first="--first" in args, copy=want_copy)
    files = [a for a in args if not a.startswith("--")]
    if files:
        return cli(files, first="--first" in args, copy=want_copy)
    run_gui(files)
    return 0


if __name__ == "__main__":
    sys.exit(main())
