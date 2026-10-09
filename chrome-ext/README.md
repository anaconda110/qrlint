# qrlint — browser extension

This directory is the unpacked Chrome/Edge (Manifest V3) extension.
Full documentation lives in the repository root: [../README.md](../README.md).

## Install

1. Open `chrome://extensions/` (Edge: `edge://extensions/`)
2. Enable **Developer mode**
3. **Load unpacked** → pick this `chrome-ext` folder

## Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest (no `<all_urls>`; uses `activeTab` + `scripting`) |
| `vendor/jsqr.js` | jsQR 1.4.0, Apache-2.0 (`vendor/jsqr.LICENSE.txt`) |
| `src/decode.js` | decoding core: raw → Otsu → 2× upscale → adaptive tiling |
| `src/background.js` | service worker: context menus, in-page decode, viewport capture, stitching |
| `src/popup.*` | toolbar popup |
| `src/offscreen.*` | clipboard image reader (service workers have no `document`) |
| `src/results.*` | multi-result list page |
| `test/` | in-browser self-check page + fixture generator |

## Self-check

```bash
cd chrome-ext
python -m http.server 8899 --bind 127.0.0.1
# then open http://127.0.0.1:8899/test/test.html — expect "OK 11/11"
```

The same suite runs headless from the repository root: `python tools/run-tests.py`.
