/*!
 * QRLink 解码核心
 * 只依赖 jsQR，操作在 {data,width,height} 的 RGBA 缓冲上，
 * 因此页面、弹窗、Service Worker、Node 里都能跑（不需要 canvas 参与解码本身）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QRLinkDecode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_PIXELS = 2600000;        // 整图解码的像素上限，超过就先降采样
  var MAX_UPSCALE_PIXELS = 1200000; // 能接受 2 倍放大的图像上限
  var TILE_TARGET_PIXELS = 2000000; // 单块解码的输入上限
  var TILE_MAX_BLOCKS = 16;         // 分块扫描的总块数上限
  var TILE_OVERLAP = 0.18;          // 相邻块重叠比例，避免码被切开
  var DEFAULT_BUDGET_MS = 8000;     // 单张图的解码时间预算

  function jsqr() {
    if (typeof jsQR === "function") return jsQR;
    if (typeof globalThis !== "undefined" && typeof globalThis.jsQR === "function") return globalThis.jsQR;
    if (typeof self !== "undefined" && typeof self.jsQR === "function") return self.jsQR;
    return null;
  }

  function uniq(list) {
    var out = [], i, v;
    for (i = 0; i < list.length; i++) {
      v = (list[i] || "").trim();
      if (v && out.indexOf(v) < 0) out.push(v);
    }
    return out;
  }

  function lum(r, g, b) { return (r * 299 + g * 587 + b * 114) / 1000; }

  function blank(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  function copyOf(id) {
    var out = blank(id.width, id.height);
    out.data.set(id.data);
    return out;
  }

  /* 最近邻缩放（放大用最近邻保住栅格边界；缩小时步进采样） */
  function resize(id, w2, h2) {
    w2 = Math.max(1, Math.round(w2));
    h2 = Math.max(1, Math.round(h2));
    var out = blank(w2, h2), s = id.data, d = out.data, sx, sy, si, di, x, y;
    for (y = 0; y < h2; y++) {
      sy = Math.min(id.height - 1, (y * id.height / h2) | 0);
      for (x = 0; x < w2; x++) {
        sx = Math.min(id.width - 1, (x * id.width / w2) | 0);
        si = (sy * id.width + sx) * 4;
        di = (y * w2 + x) * 4;
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255;
      }
    }
    return out;
  }

  /* 缩小时用面积平均：二维码是硬边缘栅格，最近邻采样会采出摩尔纹把模块图案打碎，
     面积平均把黑白混成灰阶，交给后面的自适应二值化反而稳得多。 */
  function shrink(id, w2, h2) {
    w2 = Math.max(1, Math.round(w2));
    h2 = Math.max(1, Math.round(h2));
    var out = blank(w2, h2), s = id.data, d = out.data;
    var xr = id.width / w2, yr = id.height / h2;
    for (var y = 0; y < h2; y++) {
      var y0 = Math.floor(y * yr), y1 = Math.min(id.height, Math.max(y0 + 1, Math.ceil((y + 1) * yr)));
      for (var x = 0; x < w2; x++) {
        var x0 = Math.floor(x * xr), x1 = Math.min(id.width, Math.max(x0 + 1, Math.ceil((x + 1) * xr)));
        var r = 0, g = 0, b = 0, n = 0, si;
        for (var yy = y0; yy < y1; yy++) {
          for (var xx = x0; xx < x1; xx++) {
            si = (yy * id.width + xx) * 4;
            r += s[si]; g += s[si + 1]; b += s[si + 2]; n++;
          }
        }
        var di = (y * w2 + x) * 4;
        d[di] = r / n; d[di + 1] = g / n; d[di + 2] = b / n; d[di + 3] = 255;
      }
    }
    return out;
  }

  /* Otsu 自适应阈值二值化：低对比、发灰、带渐变的二维码靠这一步救回来 */
  function binarize(id) {
    var d = id.data, hist = new Uint32Array(256), i, v;
    for (i = 0; i < d.length; i += 4) hist[lum(d[i], d[i + 1], d[i + 2]) | 0]++;
    var total = d.length / 4, sum = 0;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = -1, thr = 127;
    for (i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    var out = blank(id.width, id.height), o = out.data;
    for (i = 0; i < d.length; i += 4) {
      v = lum(d[i], d[i + 1], d[i + 2]) < thr ? 0 : 255;
      o[i] = o[i + 1] = o[i + 2] = v;
      o[i + 3] = 255;
    }
    return out;
  }

  /* 把已识别的码涂白，以便在同一张图里继续找下一个码 */
  function blankPolygon(id, pts) {
    if (!pts || pts.length < 3) return false;
    var d = id.data, w = id.width, h = id.height, i, j, k;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (i = 0; i < pts.length; i++) {
      if (!pts[i]) return false;
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    var y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
    var x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(w - 1, Math.ceil(maxX));
    if (x1 < x0 || y1 < y0) return false;
    var n = pts.length, cross = [];
    for (var y = y0; y <= y1; y++) {
      cross.length = 0;
      for (i = 0; i < n; i++) {
        j = (i + 1) % n;
        var a = pts[i], b = pts[j];
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          cross.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
        }
      }
      if (!cross.length) continue;
      cross.sort(function (p, q) { return p - q; });
      for (k = 0; k + 1 < cross.length; k += 2) {
        var sx = Math.max(x0, Math.ceil(cross[k])), ex = Math.min(x1, Math.floor(cross[k + 1]));
        for (var x = sx; x <= ex; x++) {
          var oi = (y * w + x) * 4;
          d[oi] = d[oi + 1] = d[oi + 2] = 255;
          d[oi + 3] = 255;
        }
      }
    }
    return true;
  }

  /* 单轮识别：先整张找；找到就把码涂白继续找下一个。
     注意：canOverwriteImage:true 时 jsQR 会把自己的中间结果写回传进去的缓冲，
     所以必须传一份一次性的副本，否则「涂白再找」会拿到被破坏的像素。 */
  function tryOne(id, maxCodes) {
    var f = jsqr();
    if (!f) throw new Error("jsQR 未加载");
    var work = copyOf(id), links = [], k, code, scratch;
    for (k = 0; k < maxCodes; k++) {
      code = null;
      scratch = copyOf(work);
      try {
        code = f(scratch.data, scratch.width, scratch.height, {
          inversionAttempts: "attemptBoth",   // 顺手覆盖反色码
          canOverwriteImage: true
        });
      } catch (e) { break; }
      if (!code || !code.data) break;
      links.push(code.data);
      var loc = code.location;
      var quad = loc && [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner];
      if (!quad || !blankPolygon(work, quad)) break;
    }
    return uniq(links);
  }

  /* 把图切成 cols×rows 块（带重叠）。一张图里有多个码、或大图里有小码时，
     jsQR 在整图上会直接识别失败，必须分块喂给它。 */
  function tiles(id, cols, rows) {
    var out = [], row, col;
    var tw = id.width / cols, th = id.height / rows;
    var ox = tw * TILE_OVERLAP, oy = th * TILE_OVERLAP;
    for (row = 0; row < rows; row++) {
      for (col = 0; col < cols; col++) {
        var x0 = Math.max(0, Math.floor(col * tw - ox / 2));
        var y0 = Math.max(0, Math.floor(row * th - oy / 2));
        var x1 = Math.min(id.width, Math.ceil((col + 1) * tw + ox / 2));
        var y1 = Math.min(id.height, Math.ceil((row + 1) * th + oy / 2));
        var w = x1 - x0, h = y1 - y0;
        if (w < 40 || h < 40) continue;
        var t = blank(w, h), s = id.data, d = t.data, x, y, si, di;
        for (y = 0; y < h; y++) {
          si = ((y0 + y) * id.width + x0) * 4;
          di = y * w * 4;
          for (x = 0; x < w * 4; x++) d[di + x] = s[si + x];
        }
        if (w * h > TILE_TARGET_PIXELS) {
          var k = Math.sqrt(TILE_TARGET_PIXELS / (w * h));
          t = shrink(t, w * k, h * k);
        }
        out.push(t);
      }
    }
    return out;
  }

  /* 按图的长宽比选分块方式：长图横着切、宽图竖着切，避免把码拦腰截断 */
  function tilePlan(id) {
    var ar = id.width / id.height, plans = [], side, cols, rows;
    for (side = 2; side <= 4; side++) {
      if (ar >= 1.2) { cols = side; rows = Math.max(1, Math.round(side / ar)); }
      else if (ar <= 0.83) { rows = side; cols = Math.max(1, Math.round(side * ar)); }
      else { cols = side; rows = side; }
      if (cols * rows > TILE_MAX_BLOCKS) continue;
      if (plans.length && plans[plans.length - 1][0] === cols && plans[plans.length - 1][1] === rows) continue;
      plans.push([cols, rows]);
    }
    return plans;
  }

  /**
   * 从 RGBA 缓冲解出二维码文本。
   * 依次尝试：整图 → 二值化 → 2 倍放大 → 分块（2×2 / 3×3 / 4×4）。
   * @param {{data:Uint8ClampedArray,width:number,height:number}} id
   * @param {{maxCodes?:number,budgetMs?:number}} [opts]
   * @returns {{links:string[], pass:(string|null)}}
   */
  function decodeImageData(id, opts) {
    opts = opts || {};
    var maxCodes = opts.maxCodes || 8;
    var deadline = Date.now() + (opts.budgetMs || DEFAULT_BUDGET_MS);
    var left = function () { return deadline - Date.now(); };
    if (!id || !id.data || !id.width || !id.height) return { links: [], pass: null };

    var big = id.width * id.height > MAX_PIXELS;
    var work = big ? shrink(id, id.width * Math.sqrt(MAX_PIXELS / (id.width * id.height)),
                                id.height * Math.sqrt(MAX_PIXELS / (id.width * id.height))) : id;

    /* 1. 整图（大图先降到解码预算内） */
    var links = tryOne(work, maxCodes);
    if (links.length) return { links: links, pass: big ? "downscaled" : "raw" };

    if (left() > 0) {
      links = tryOne(binarize(work), maxCodes);
      if (links.length) return { links: links, pass: "otsu" };
    }

    /* 2. 小图放大 2 倍：截屏里的小二维码靠这一步 */
    if (!big && work.width * work.height <= MAX_UPSCALE_PIXELS && left() > 0) {
      var up = resize(work, work.width * 2, work.height * 2);
      links = tryOne(up, maxCodes);
      if (links.length) return { links: links, pass: "2x" };
      if (left() > 0) {
        links = tryOne(binarize(up), maxCodes);
        if (links.length) return { links: links, pass: "2x+otsu" };
      }
    }

    /* 3. 分块扫描：多个码并排、长截图、大图小码 */
    var plans = tilePlan(id);
    for (var gi = 0; gi < plans.length; gi++) {
      if (left() <= 0) break;
      var g = plans[gi];
      var grid = tiles(id, g[0], g[1]);          // 分块在原图分辨率上取，避免小码被抹掉
      var hits = [];
      for (var ti = 0; ti < grid.length; ti++) {
        if (left() <= 0) break;
        hits.push.apply(hits, tryOne(grid[ti], maxCodes));
        if (!hits.length && left() > 0) hits.push.apply(hits, tryOne(binarize(grid[ti]), maxCodes));
      }
      hits = uniq(hits);
      if (hits.length) return { links: hits, pass: "tiles" + g[0] + "x" + g[1] };
    }
    return { links: [], pass: null };
  }

  /* ---------------- 需要 canvas 的取像素入口 ---------------- */

  function makeCanvas(w, h) {
    if (typeof document !== "undefined" && document.createElement) {
      var c = document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    }
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    throw new Error("当前环境没有 canvas，无法取像素");
  }

  function ctx2d(canvas) {
    var g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("拿不到 2d 绘图上下文");
    return g;
  }

  function sizeOf(d) {
    return {
      w: d.naturalWidth || d.videoWidth || d.width,
      h: d.naturalHeight || d.videoHeight || d.height
    };
  }

  /* 图片/位图 → ImageData（跨域未授权的图片会在 getImageData 处抛 SecurityError） */
  function imageDataFromDrawable(drawable, maxPixels) {
    var s = sizeOf(drawable);
    if (!s.w || !s.h) throw new Error("读不到图片尺寸");
    var scale = 1;
    if (maxPixels && s.w * s.h > maxPixels) scale = Math.sqrt(maxPixels / (s.w * s.h));
    var w = Math.max(1, Math.round(s.w * scale)), h = Math.max(1, Math.round(s.h * scale));
    var c = makeCanvas(w, h), g = ctx2d(c);
    g.imageSmoothingEnabled = scale < 1;
    g.drawImage(drawable, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }

  function fromDrawable(drawable, opts) {
    return decodeImageData(imageDataFromDrawable(drawable, MAX_PIXELS), opts);
  }

  function fromCanvas(canvas, opts) {
    return decodeImageData(ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height), opts);
  }

  function fromBlob(blob, opts) {
    return createImageBitmap(blob).then(function (bmp) {
      try { return fromDrawable(bmp, opts); }
      finally { if (bmp.close) bmp.close(); }
    });
  }

  function fromImageDataLike(id, opts) { return decodeImageData(id, opts); }

  return {
    decodeImageData: decodeImageData,
    fromImageDataLike: fromImageDataLike,
    fromDrawable: fromDrawable,
    fromCanvas: fromCanvas,
    fromBlob: fromBlob,
    resize: resize,
    shrink: shrink,
    binarize: binarize,
    uniq: uniq,
    MAX_PIXELS: MAX_PIXELS
  };
});
