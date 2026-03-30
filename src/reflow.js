/**
 * pretext-pdfjs/reflow
 *
 * Per-block reflow renderer for PDF pages. Text blocks reflow with Pretext
 * preserving relative font sizes, weight, and style. Non-text regions
 * (images, vector graphics) render as scaled bitmaps.
 */

import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";

// ─── Helpers ──────────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function bboxOverlap(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? intersection / smaller : 0;
}

// ─── Page analysis ────────────────────────────────────────────────────────

/**
 * Group adjacent text items into text blocks by proximity.
 * Also extracts font metadata: average size, italic, bold.
 */
function groupTextBlocks(textItems, pageHeight, styles) {
  const sorted = [...textItems].filter(i => i.str?.trim()).sort((a, b) => {
    const ay = pageHeight - a.transform[5];
    const by = pageHeight - b.transform[5];
    if (Math.abs(ay - by) > 2) return ay - by;
    return a.transform[4] - b.transform[4];
  });

  const blocks = [];
  let current = null;

  for (const item of sorted) {
    const x = item.transform[4];
    const y = pageHeight - item.transform[5];
    const fontHeight = Math.hypot(item.transform[2], item.transform[3]);

    if (!current) {
      current = {
        items: [item],
        bbox: { x, y, w: item.width || 0, h: fontHeight },
      };
      continue;
    }

    const lastItem = current.items[current.items.length - 1];
    const lastY = pageHeight - lastItem.transform[5];
    const lastFH = Math.hypot(lastItem.transform[2], lastItem.transform[3]);
    const verticalGap = Math.abs(y - lastY);

    // Split block on significant font size change (headings vs body)
    const sizeRatio = fontHeight > 0 && lastFH > 0
      ? Math.max(fontHeight, lastFH) / Math.min(fontHeight, lastFH)
      : 1;

    if (
      sizeRatio < 1.3 &&
      verticalGap < lastFH * 2.5 &&
      x < current.bbox.x + current.bbox.w + lastFH * 2
    ) {
      current.items.push(item);
      current.bbox.x = Math.min(current.bbox.x, x);
      current.bbox.w =
        Math.max(current.bbox.x + current.bbox.w, x + (item.width || 0)) -
        current.bbox.x;
      current.bbox.h = y + fontHeight - current.bbox.y;
    } else {
      blocks.push(current);
      current = {
        items: [item],
        bbox: { x, y, w: item.width || 0, h: fontHeight },
      };
    }
  }
  if (current) blocks.push(current);

  // Compute font metadata per block
  for (const block of blocks) {
    const sizes = [];
    let italicCount = 0;
    let boldCount = 0;

    for (const item of block.items) {
      const fh = Math.hypot(item.transform[2], item.transform[3]);
      if (fh > 0) sizes.push(fh);

      // Detect italic/bold from fontName and style
      const name = (item.fontName || "").toLowerCase();
      const style = styles?.[item.fontName];
      const family = (style?.fontFamily || "").toLowerCase();
      const combined = name + " " + family;

      if (combined.includes("italic") || combined.includes("oblique")) italicCount++;
      if (combined.includes("bold") || combined.includes("black") || combined.includes("heavy")) boldCount++;

      // Also detect italic from transform skew
      if (Math.abs(item.transform[2]) > 0.1 && Math.abs(item.transform[1]) < 0.1) {
        italicCount++;
      }
    }

    block.avgFontSize = sizes.length
      ? sizes.reduce((a, b) => a + b, 0) / sizes.length
      : 12;
    block.isItalic = italicCount > block.items.length * 0.4;
    block.isBold = boldCount > block.items.length * 0.4;

    // Detect font family from the PDF's style metadata
    const sampleStyle = styles?.[block.items[0]?.fontName];
    block.pdfFontFamily = sampleStyle?.fontFamily || null;
  }

  return blocks;
}

/**
 * Extract graphic regions from the page operator list.
 * Only captures image operators (paintImageXObject etc).
 * Skips path/fill/stroke to avoid false positives from text decorations.
 */
async function extractGraphicRegions(page, OPS) {
  const ops = await page.getOperatorList();
  const regions = [];
  const ctmStack = [];
  let ctm = [1, 0, 0, 1, 0, 0];

  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintJpegXObject,
    OPS.paintImageXObjectRepeat,
  ]);

  function multiplyMatrix(a, b) {
    return [
      a[0] * b[0] + a[2] * b[1],
      a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3],
      a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4],
      a[1] * b[4] + a[3] * b[5] + a[5],
    ];
  }

  function transformPoint(x, y) {
    return [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  }

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];

    if (fn === OPS.save) {
      ctmStack.push(ctm.slice());
    } else if (fn === OPS.restore) {
      if (ctmStack.length > 0) ctm = ctmStack.pop();
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrix(ctm, args);
    } else if (imageOps.has(fn)) {
      const corners = [
        transformPoint(0, 0),
        transformPoint(1, 0),
        transformPoint(0, 1),
        transformPoint(1, 1),
      ];
      const xs = corners.map(c => c[0]);
      const ys = corners.map(c => c[1]);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      if (maxX - minX > 10 && maxY - minY > 10) {
        regions.push({
          type: "graphic",
          bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
        });
      }
    }
  }

  return regions;
}

/**
 * Build text content for a block, preserving paragraph breaks.
 */
function blockToText(block, pageHeight) {
  let result = "";
  let lastY = null;
  let lastFontSize = 12;

  for (const item of block.items) {
    if (!item.str) continue;
    const currentY = pageHeight - item.transform[5];
    const fontHeight = Math.hypot(item.transform[2], item.transform[3]);
    if (fontHeight > 0) lastFontSize = fontHeight;

    if (lastY !== null) {
      const gap = Math.abs(currentY - lastY);
      if (gap > lastFontSize * 1.8) {
        result += "\n\n";
      } else if (gap > lastFontSize * 0.3) {
        if (!result.endsWith(" ") && !result.endsWith("\n")) {
          result += " ";
        }
      }
    }
    lastY = currentY;
    result += item.str;
  }
  return result.trim();
}

/**
 * Build a region map: text blocks + graphic regions, sorted in reading order.
 * Filters out graphic regions that overlap with text blocks.
 */
function buildRegionMap(textBlocks, graphicRegions, pageHeight) {
  const regions = [];
  const textBboxes = [];

  for (const block of textBlocks) {
    const bbox = { ...block.bbox };
    regions.push({ type: "text", block, bbox });
    textBboxes.push(bbox);
  }

  for (const gr of graphicRegions) {
    // PDF coords: y is from bottom → convert to top-down
    const topY = pageHeight - gr.bbox.y - gr.bbox.h;
    const bbox = { x: gr.bbox.x, y: topY, w: gr.bbox.w, h: gr.bbox.h };

    // Skip if this graphic region overlaps significantly with any text block
    const overlapsText = textBboxes.some(tb => bboxOverlap(bbox, tb) > 0.3);
    if (!overlapsText) {
      regions.push({ type: "graphic", bbox });
    }
  }

  // Sort by reading order: top to bottom, then left to right
  regions.sort((a, b) => {
    if (Math.abs(a.bbox.y - b.bbox.y) > 10) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  });

  return regions;
}

// ─── Page analysis cache ──────────────────────────────────────────────────

async function analyzePage(page, OPS) {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // Get text content with styles
  const textContent = await page.getTextContent();
  const textBlocks = groupTextBlocks(textContent.items, pageHeight, textContent.styles);

  // Compute body font size (most common size = body text)
  const allSizes = textBlocks.map(b => Math.round(b.avgFontSize * 10) / 10);
  const freq = {};
  for (const s of allSizes) freq[s] = (freq[s] || 0) + 1;
  let bodyFontSize = 12;
  let maxFreq = 0;
  for (const [s, f] of Object.entries(freq)) {
    if (f > maxFreq) { maxFreq = f; bodyFontSize = parseFloat(s); }
  }
  // Compute fontScale per block
  for (const block of textBlocks) {
    block.fontScale = block.avgFontSize / bodyFontSize;
  }

  // Get graphic regions (images only, no paths)
  const graphicRegions = await extractGraphicRegions(page, OPS);

  // Render full page to offscreen canvas for bitmap extraction
  const renderScale = 2;
  const offCanvas = document.createElement("canvas");
  offCanvas.width = Math.floor(pageWidth * renderScale);
  offCanvas.height = Math.floor(pageHeight * renderScale);
  const offCtx = offCanvas.getContext("2d");

  const renderViewport = page.getViewport({ scale: renderScale });
  await page.render({
    canvasContext: offCtx,
    viewport: renderViewport,
  }).promise;

  // Build region map (filters overlapping graphics)
  const regionMap = buildRegionMap(textBlocks, graphicRegions, pageHeight);

  // Extract bitmap snippets for graphic regions only
  const bitmaps = new Map();
  for (const region of regionMap) {
    if (region.type !== "graphic") continue;
    const b = region.bbox;
    const sx = Math.max(0, Math.floor(b.x * renderScale));
    const sy = Math.max(0, Math.floor(b.y * renderScale));
    const sw = Math.min(Math.floor(b.w * renderScale), offCanvas.width - sx);
    const sh = Math.min(Math.floor(b.h * renderScale), offCanvas.height - sy);
    if (sw > 0 && sh > 0) {
      const imgData = offCtx.getImageData(sx, sy, sw, sh);
      bitmaps.set(region, { data: imgData, sourceW: b.w, sourceH: b.h });
    }
  }

  return {
    pageWidth,
    pageHeight,
    regionMap,
    bitmaps,
    textBlocks,
    graphicRegions,
    offCanvas,
  };
}

// ─── Reflow + composite engine ────────────────────────────────────────────

function reflowAndComposite(analysis, opts) {
  const { regionMap, bitmaps, pageWidth, pageHeight } = analysis;
  const {
    fontSize, fontFamily, lineHeight, padding, background,
    textColor, imageFit, canvasW,
  } = opts;

  const availableWidth = canvasW - padding * 2;

  // No regions → render full page bitmap
  if (regionMap.length === 0 || !regionMap.some(r => r.type === "text")) {
    const scale = Math.min(availableWidth / pageWidth, 1);
    return {
      totalHeight: pageHeight * scale + padding * 2,
      reflowedRegions: [],
      fullPageFallback: true,
    };
  }

  const reflowedRegions = [];

  for (const region of regionMap) {
    if (region.type === "text") {
      const block = region.block;
      const text = blockToText(block, pageHeight);
      if (!text) {
        reflowedRegions.push({ type: "text", lines: [], height: 0, region });
        continue;
      }

      // Per-block font properties
      const blockFontSize = Math.round(fontSize * (block.fontScale || 1));
      const blockLH = blockFontSize * lineHeight;
      const style = block.isItalic ? "italic" : "normal";
      // Headings get lighter weight to match typical PDF display fonts
      const scale = block.fontScale || 1;
      const weight = block.isBold ? 700 : scale > 1.8 ? 300 : scale > 1.3 ? 400 : 400;
      // Use PDF's detected font family if available, otherwise fall back to configured
      const blockFamily = block.pdfFontFamily
        ? `${block.pdfFontFamily}, ${fontFamily}`
        : fontFamily;
      const font = `${style} ${weight} ${blockFontSize}px ${blockFamily}`;

      const prepared = prepareWithSegments(text, font);
      const result = layoutWithLines(prepared, availableWidth, blockLH);
      const blockHeight = result.lines.length * blockLH;

      reflowedRegions.push({
        type: "text",
        lines: result.lines,
        height: blockHeight,
        fontSize: blockFontSize,
        lineHeight: blockLH,
        fontStyle: style,
        fontWeight: weight,
        fontFamily: blockFamily,
        region,
      });
    } else {
      // Graphic
      const bitmap = bitmaps.get(region);
      if (!bitmap) {
        reflowedRegions.push({ type: "graphic", height: 0, region });
        continue;
      }
      let drawW = bitmap.sourceW;
      let drawH = bitmap.sourceH;
      if (imageFit === "full-width") {
        const s = availableWidth / drawW;
        drawW = availableWidth;
        drawH = bitmap.sourceH * s;
      } else if (drawW > availableWidth) {
        const s = availableWidth / drawW;
        drawW *= s;
        drawH *= s;
      }
      reflowedRegions.push({
        type: "graphic",
        height: drawH,
        drawW,
        drawH,
        bitmap,
        region,
      });
    }
  }

  // Total height
  const baseLH = fontSize * lineHeight;
  let totalHeight = padding;
  for (const r of reflowedRegions) {
    totalHeight += r.height;
    totalHeight += baseLH * 0.4;
  }
  totalHeight += padding;

  return { totalHeight, reflowedRegions, fullPageFallback: false };
}

/**
 * Draw the reflowed content to canvas.
 */
function drawComposite(ctx, reflowedRegions, analysis, opts, scrollY) {
  const {
    fontSize, fontFamily, lineHeight, padding,
    background, textColor, canvasW, canvasH, dpr,
  } = opts;

  const d = dpr;
  const baseLH = fontSize * lineHeight;

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvasW * d, canvasH * d);

  // Full page fallback
  if (reflowedRegions.length === 0 && analysis.offCanvas) {
    const availableWidth = canvasW - padding * 2;
    const scale = Math.min(availableWidth / analysis.pageWidth, 1);
    ctx.drawImage(
      analysis.offCanvas,
      padding * d, padding * d,
      analysis.pageWidth * scale * d,
      analysis.pageHeight * scale * d
    );
    return;
  }

  let cursorY = padding;
  ctx.textBaseline = "top";

  for (const r of reflowedRegions) {
    if (r.type === "text" && r.lines) {
      const fs = r.fontSize || fontSize;
      const lh = r.lineHeight || baseLH;
      const style = r.fontStyle || "normal";
      const weight = r.fontWeight || 400;

      ctx.fillStyle = textColor;
      ctx.font = `${style} ${weight} ${fs * d}px ${fontFamily}`;

      for (const line of r.lines) {
        const screenY = cursorY - scrollY;
        if (screenY > -lh && screenY < canvasH + lh) {
          ctx.fillText(line.text, padding * d, screenY * d);
        }
        cursorY += lh;
      }
    } else if (r.type === "graphic" && r.bitmap) {
      const screenY = cursorY - scrollY;
      if (screenY > -r.drawH && screenY < canvasH + r.drawH) {
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = r.bitmap.data.width;
        tmpCanvas.height = r.bitmap.data.height;
        tmpCanvas.getContext("2d").putImageData(r.bitmap.data, 0, 0);
        ctx.drawImage(
          tmpCanvas,
          padding * d, screenY * d,
          r.drawW * d, r.drawH * d
        );
      }
      cursorY += r.drawH;
    }
    cursorY += baseLH * 0.4;
  }
}

// ─── Main API ─────────────────────────────────────────────────────────────

export function createReflowRenderer(container, options = {}) {
  const minFont = options.minFontSize ?? 8;
  const maxFont = options.maxFontSize ?? 48;
  const fontFamily = options.fontFamily ?? '"Literata", Georgia, serif';
  const lhRatio = options.lineHeight ?? 1.6;
  const padding = options.padding ?? 24;
  const bg = options.background ?? "#f4f1eb";
  const textColor = options.textColor ?? "#252320";
  const imageFit = options.imageFit ?? "proportional";
  const enablePinchZoom = options.enablePinchZoom ?? true;
  const enableMomentumScroll = options.enableMomentumScroll ?? true;
  const friction = options.friction ?? 0.95;
  const onZoom = options.onZoom;
  const onPageReady = options.onPageReady;

  let pdfjs = null;
  let pdfDoc = null;
  let currentPage = 0;
  let fontSize = options.fontSize ?? 16;
  let destroyed = false;

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.touchAction = "none";
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  let dpr = Math.min(devicePixelRatio || 1, 3);
  let W = 0, H = 0;

  const analysisCache = new Map();
  let currentAnalysis = null;
  let reflowedRegions = [];
  let totalHeight = 0;

  let scrollY = 0, scrollVelocity = 0, maxScroll = 0;
  let touchLastY = 0, touchLastTime = 0, isTouching = false;
  let pinchActive = false, pinchStartDist = 0, pinchStartSize = 0;
  let raf = 0;

  // Cached tmp canvases for graphic bitmaps (avoid creating per frame)
  const tmpCanvasCache = new WeakMap();
  function getTmpCanvas(bitmap) {
    let c = tmpCanvasCache.get(bitmap);
    if (!c) {
      c = document.createElement("canvas");
      c.width = bitmap.data.width;
      c.height = bitmap.data.height;
      c.getContext("2d").putImageData(bitmap.data, 0, 0);
      tmpCanvasCache.set(bitmap, c);
    }
    return c;
  }

  async function ensurePdfjs() {
    if (pdfjs) return;
    pdfjs = await import("pdfjs-dist");
    if (options.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
    }
  }

  function reflow() {
    if (!currentAnalysis || W === 0) return;
    const result = reflowAndComposite(currentAnalysis, {
      fontSize, fontFamily, lineHeight: lhRatio, padding,
      background: bg, textColor, imageFit, canvasW: W, canvasH: H, dpr,
    });
    reflowedRegions = result.reflowedRegions;
    totalHeight = result.totalHeight;
    maxScroll = Math.max(0, totalHeight - H);
    scrollY = clamp(scrollY, 0, maxScroll);
  }

  function render() {
    if (!currentAnalysis) {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W * dpr, H * dpr);
      return;
    }
    // Inline draw for performance (avoid function call overhead in rAF)
    const d = dpr;
    const baseLH = fontSize * lhRatio;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W * d, H * d);

    if (reflowedRegions.length === 0 && currentAnalysis.offCanvas) {
      const availW = W - padding * 2;
      const scale = Math.min(availW / currentAnalysis.pageWidth, 1);
      ctx.drawImage(
        currentAnalysis.offCanvas,
        padding * d, padding * d,
        currentAnalysis.pageWidth * scale * d,
        currentAnalysis.pageHeight * scale * d
      );
      return;
    }

    let cursorY = padding;
    ctx.textBaseline = "top";

    for (const r of reflowedRegions) {
      if (r.type === "text" && r.lines) {
        const fs = r.fontSize || fontSize;
        const lh = r.lineHeight || baseLH;
        const rFamily = r.fontFamily || fontFamily;
        ctx.fillStyle = textColor;
        ctx.font = `${r.fontStyle || "normal"} ${r.fontWeight || 400} ${fs * d}px ${rFamily}`;

        for (const line of r.lines) {
          const screenY = cursorY - scrollY;
          if (screenY > -lh && screenY < H + lh) {
            ctx.fillText(line.text, padding * d, screenY * d);
          }
          cursorY += lh;
        }
      } else if (r.type === "graphic" && r.bitmap) {
        const screenY = cursorY - scrollY;
        if (screenY > -r.drawH && screenY < H + r.drawH) {
          const tmp = getTmpCanvas(r.bitmap);
          ctx.drawImage(tmp, padding * d, screenY * d, r.drawW * d, r.drawH * d);
        }
        cursorY += r.drawH;
      }
      cursorY += baseLH * 0.4;
    }
  }

  function loop() {
    if (destroyed) return;
    if (!isTouching && enableMomentumScroll) {
      scrollY += scrollVelocity;
      scrollVelocity *= friction;
      if (scrollY < 0) { scrollY *= 0.85; scrollVelocity *= 0.5; }
      else if (scrollY > maxScroll) {
        scrollY = maxScroll + (scrollY - maxScroll) * 0.85;
        scrollVelocity *= 0.5;
      }
      if (Math.abs(scrollVelocity) < 0.1) scrollVelocity = 0;
    }
    render();
    raf = requestAnimationFrame(loop);
  }

  // ── Gestures ──

  function pDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(e) {
    if (e.touches.length === 2 && enablePinchZoom) {
      pinchActive = true;
      pinchStartDist = pDist(e);
      pinchStartSize = fontSize;
      scrollVelocity = 0;
      isTouching = false;
    } else if (e.touches.length === 1 && !pinchActive) {
      isTouching = true;
      scrollVelocity = 0;
      touchLastY = e.touches[0].clientY;
      touchLastTime = performance.now();
    }
    e.preventDefault();
  }

  function onTouchMove(e) {
    if (pinchActive && e.touches.length === 2 && enablePinchZoom) {
      const scale = pDist(e) / pinchStartDist;
      const newSize = clamp(Math.round(pinchStartSize * scale), minFont, maxFont);
      if (newSize !== fontSize) {
        fontSize = newSize;
        reflow();
        onZoom?.(fontSize);
      }
      e.preventDefault();
      return;
    }
    if (!isTouching || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const dy = touchLastY - y;
    const now = performance.now();
    const dt = now - touchLastTime;
    scrollY += dy;
    scrollY = clamp(scrollY, -50, maxScroll + 50);
    if (dt > 0) scrollVelocity = (dy / dt) * 16;
    touchLastY = y;
    touchLastTime = now;
    e.preventDefault();
  }

  function onTouchEnd(e) {
    if (e.touches.length < 2) pinchActive = false;
    if (e.touches.length === 0) isTouching = false;
  }

  function onWheel(e) {
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && enablePinchZoom) {
      const delta = e.deltaY > 0 ? -1 : 1;
      const newSize = clamp(fontSize + delta, minFont, maxFont);
      if (newSize !== fontSize) {
        fontSize = newSize;
        reflow();
        onZoom?.(fontSize);
      }
    } else {
      scrollY += e.deltaY;
      scrollY = clamp(scrollY, -50, maxScroll + 50);
    }
  }

  function handleResize() {
    dpr = Math.min(devicePixelRatio || 1, 3);
    W = Math.min(container.clientWidth, 680);
    H = container.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    reflow();
  }

  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", handleResize);
  handleResize();
  raf = requestAnimationFrame(loop);

  return {
    async open(source) {
      await ensurePdfjs();
      const loadParams =
        source instanceof Uint8Array || source instanceof ArrayBuffer
          ? { data: source }
          : typeof source === "string"
            ? { url: source }
            : source;
      pdfDoc = await pdfjs.getDocument(loadParams).promise;
      analysisCache.clear();
      return { numPages: pdfDoc.numPages };
    },

    async showPage(pageNum) {
      if (!pdfDoc) throw new Error("Call open() first");
      if (pageNum < 1 || pageNum > pdfDoc.numPages) {
        throw new RangeError(`Page ${pageNum} out of range`);
      }

      if (!analysisCache.has(pageNum)) {
        const page = await pdfDoc.getPage(pageNum);
        analysisCache.set(pageNum, await analyzePage(page, pdfjs.OPS));
      }

      currentAnalysis = analysisCache.get(pageNum);
      currentPage = pageNum;
      scrollY = 0;
      scrollVelocity = 0;
      reflow();

      onPageReady?.({
        pageNum,
        textBlocks: currentAnalysis.textBlocks,
        graphicRegions: currentAnalysis.graphicRegions,
      });
    },

    async showAll() {
      if (!pdfDoc) throw new Error("Call open() first");

      const allRegionMaps = [];
      const allBitmaps = new Map();
      let combinedPageHeight = 0;

      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (!analysisCache.has(i)) {
          const page = await pdfDoc.getPage(i);
          analysisCache.set(i, await analyzePage(page, pdfjs.OPS));
        }
        const analysis = analysisCache.get(i);
        for (const region of analysis.regionMap) {
          const offsetRegion = {
            ...region,
            bbox: { ...region.bbox, y: region.bbox.y + combinedPageHeight },
          };
          allRegionMaps.push(offsetRegion);
          if (region.type === "graphic" && analysis.bitmaps.has(region)) {
            allBitmaps.set(offsetRegion, analysis.bitmaps.get(region));
          }
        }
        combinedPageHeight += analysis.pageHeight + 20;
      }

      const first = analysisCache.get(1);
      currentAnalysis = {
        pageWidth: first.pageWidth,
        pageHeight: combinedPageHeight,
        regionMap: allRegionMaps,
        bitmaps: allBitmaps,
        textBlocks: allRegionMaps.filter(r => r.type === "text").map(r => r.block).filter(Boolean),
        graphicRegions: allRegionMaps.filter(r => r.type === "graphic"),
        offCanvas: first.offCanvas,
      };

      currentPage = -1;
      scrollY = 0;
      scrollVelocity = 0;
      reflow();
    },

    async nextPage() {
      if (pdfDoc && currentPage > 0 && currentPage < pdfDoc.numPages) {
        return this.showPage(currentPage + 1);
      }
    },

    async prevPage() {
      if (pdfDoc && currentPage > 1) {
        return this.showPage(currentPage - 1);
      }
    },

    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", handleResize);
      canvas.remove();
      analysisCache.clear();
      pdfDoc?.destroy();
      pdfDoc = null;
    },

    setFontSize(newSize) {
      const clamped = clamp(newSize, minFont, maxFont);
      if (clamped !== fontSize) {
        fontSize = clamped;
        reflow();
        onZoom?.(fontSize);
      }
    },

    get fontSize() { return fontSize; },
    get currentPage() { return currentPage; },
    get numPages() { return pdfDoc?.numPages || 0; },
    get canvas() { return canvas; },
    get regions() {
      if (!currentAnalysis) return { text: [], graphic: [] };
      return {
        text: currentAnalysis.textBlocks,
        graphic: currentAnalysis.graphicRegions,
      };
    },
  };
}
