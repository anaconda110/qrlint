# qrlint · 二维码取链

Chrome/Edge 扩展与命令行小工具，用来把二维码里的链接直接抠出来。
图片上的、CSS 背景图上的、`<canvas>` 画的、整页长截图里的，都能扫；结果自动进剪贴板。

**纯本地运行**：不联网、不登录、不上报，二维码识别全在你机器上完成。

```
┌─ 网页里的二维码 ─┐        ┌─ 命令行 / 桌面 ─┐
│ 图片 / 背景图 /   │        │ 剪贴板 / 截图 / │
│ canvas / 长截图   │        │ 图片文件        │
└────────┬─────────┘        └────────┬───────┘
         │                           │
         └────────► 链接进剪贴板 ◄────┘
```

## 两条使用路线

| 方式 | 适合 | 入口 |
| --- | --- | --- |
| **浏览器扩展** | 网页上的二维码 | Chrome/Edge 加载 `chrome-ext/`，点图标或页面右键 |
| **命令行 + 桌面快捷方式** | 截图、剪贴板图片、本地图片文件 | `python qrlink.py`，或双击快捷方式 |

## 一、浏览器扩展（推荐）

### 安装

1. 打开 `chrome://extensions/`（Edge 用 `edge://extensions/`）
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库的 `chrome-ext` 目录
4. 建议把扩展图标固定到工具栏（拼图图标 → 图钉）

未上架商店，只能开发者模式加载；换机器需重新加载一次。

### 用法

| 入口 | 操作 |
| --- | --- |
| 工具栏图标 | 弹窗四个按钮：扫描本页图片 / 框选二维码 / 整页扫描 / 剪贴板图片 |
| 页面右键 | 「二维码取链 →」子菜单，含上面四项；右键点在图片上时多一条「从这张图片解二维码」 |

解码成功后第 1 条自动进剪贴板、弹一条系统通知，图标上短暂显示结果个数；多条结果会在后台另开一个标签页逐条列出。

### 它怎么处理各种难缠的图

- **普通 `<img>`**：把 jsQR 注入页面的隔离世界，用页面自己的 canvas 取像素解码。同源图、data URL、
  允许跨域的图都走这条最快路径。
- **读不到像素的图**（跨域未授权、CSS 背景图、`<canvas>`）：退回 `captureVisibleTab` 截当前视口，
  按元素矩形裁一块再解。
- **整页扫描**：自动滚动逐屏截图，在内存里拼成一张长图解码；滚动期间临时隐藏 `position: fixed/sticky`
  的元素，避免页头页脚在每一屏重复出现，结束后恢复原状与滚动位置。
- **剪贴板**：Service Worker 里没有 `document`，借一个 offscreen 页面读剪贴板位图。

### 权限说明

只用 `contextMenus` / `activeTab` / `scripting` / `clipboardRead` / `clipboardWrite` /
`notifications` / `offscreen`，**不申请 `<all_urls>`**，所以不会读取你没在操作的页面。
跨域图片靠上面那两条路（页内解码 + 截屏裁剪）绕开主机权限，这也是为什么不申请全站权限。

## 二、命令行 / 桌面工具

```bash
python qrlink.py --first 图片.png     # 只打印第一个结果
python qrlink.py 图片.png 另一张.png  # 全部结果
python qrlink.py --clip              # 读剪贴板图片
python qrlink.py --clip --copy       # 顺带写回剪贴板
pythonw qrlink.py                    # 打开图形界面
```

图形界面里可以点「读剪贴板 / 选图片 / 屏幕框选」，默认把第一条结果复制到剪贴板，双击某行直接打开链接。

依赖（只用到已安装的）：`pillow`、`opencv-python`，可选 `zxing-cpp`。

Windows 上要桌面快捷方式的话：新建指向 `qrlink.vbs` 的快捷方式（`qrlink.vbs` 会无窗口启动 GUI）；
把 `qrlink.cmd` 的快捷方式丢进「发送到」目录，右键图片 →「发送到」就能直接解。

> `qrlink.vbs` 里的 Python 解释器路径按这个顺序找：
> `%QRLINK_PYTHONW%` 环境变量 → `C:\ProgramData\anaconda3\pythonw.exe` → PATH 里的 `pythonw.exe`。
> 装在其他位置就设一下 `QRLINK_PYTHONW`。

## 三、解码核心

`chrome-ext/src/decode.js` 是纯函数式的解码核心（只依赖一个 RGBA 缓冲，不碰 DOM），
命令行与扩展共用同一套思路。它按下面的顺序尝试，每步都有时间预算：

1. 整图直接解（超大图先面积平均降采样）
2. Otsu 自适应二值化后再解（低对比、发灰的码）
3. 2 倍放大再解（截屏里的小码）
4. 按长宽比自适应分块（长图横切、宽图竖切，邻块带 18% 重叠）—— 多个码并排、大图里的小码靠这步

### 踩过的两个坑（改动时别踩回去）

- **`canOverwriteImage: true` 会破坏像素缓冲**：jsQR 打开这个选项后会把自己的中间结果写回你传进去的
  `Uint8ClampedArray`。想「识别一个 → 涂白 → 再找下一个」就必须每次传一次性副本，否则第二轮拿到的是被写花的图。
- **缩小图片不能用最近邻采样**：二维码是硬边缘栅格，最近邻缩小时会采出摩尔纹把模块图案打碎。
  缩小一律用面积平均，把黑白混成灰阶，再交给二值化，稳得多。

## 测试

浏览器里跑（真实 Chrome，与扩展同一份代码）：

```bash
cd chrome-ext
python -m http.server 8899 --bind 127.0.0.1
# 打开 http://127.0.0.1:8899/test/test.html
```

页面会把 11 个用例逐个跑一遍并显示通过情况，标题栏变成 `OK 11/11`。
用例图由 `test/make_fixtures.py` 生成（内联成 data URL 写进 `fixtures.js`），需要
`pillow`、`qrcode`、`numpy`；`test/scanpage.html` 是配合「扫描本页图片」用的页面。

## 目录结构

```
chrome-ext/
├─ manifest.json           # MV3
├─ vendor/jsqr.js          # jsQR 1.4.0（Apache-2.0，见 vendor/jsqr.LICENSE.txt）
├─ src/
│  ├─ decode.js            # 解码核心：整图 → 二值化 → 放大 → 自适应分块
│  ├─ background.js        # Service Worker：右键菜单、取图、截图、拼接、投递结果
│  ├─ popup.html/js        # 弹窗
│  ├─ offscreen.html/js    # 读剪贴板
│  └─ results.html/js      # 多结果列表页
├─ icons/
└─ test/                   # 自检页 + 用例生成脚本
qrlink.py                  # 命令行 / GUI
qrlink.vbs / qrlink.cmd    # Windows 快捷方式入口
```

## 已知边界

- 浏览器内部页面（`chrome://`、扩展商店等）不能用，弹窗会提示。
- 图片被 CORS 限制且不在视口内时，截屏兜底也拿不到 —— 把图滚进视野再扫即可。
- 一次扫描最多 40 张图、整页扫描最多 24 屏，这是防止超大页面拖死解码的硬上限。
- 模糊/倾斜严重的图单张可能要 1–2 秒，属正常。

## License

MIT，见 [LICENSE](LICENSE)。内置的 jsQR 是 Apache-2.0，见 [chrome-ext/vendor/jsqr.LICENSE.txt](chrome-ext/vendor/jsqr.LICENSE.txt)。
