/**
 * pretext-pdf/pinch
 *
 * Integrates pinch-type (Lucas Crespo) into the PDF viewer pipeline.
 * Enables three reading modes for PDF text:
 *
 *   1. pinchType  — pinch-to-zoom resizes text, not the page
 *   2. scrollMorph — fisheye: center text large/bright, edges small/dim
 *   3. pinchMorph  — both combined
 *
 * These modes extract text from a PDF page via pdfjs-dist, then render
 * it to a Canvas using @chenglou/pretext for layout and pinch-type's
 * gesture engine for interaction.
 *
 * Usage:
 *   import { createPDFPinchReader } from "pretext-pdf/pinch";
 *
 *   const reader = createPDFPinchReader(container, {
 *     mode: "pinchMorph",
 *     workerSrc: "path/to/pdf.worker.min.mjs",
 *   });
 *   await reader.open("document.pdf");
 *   await reader.showPage(1);    // extracts text, renders with pinch-type
 *   reader.destroy();
 */

import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";

// ─── Shared helpers ────────────────────────────────────────────────────────

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function createCanvas(container) {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  container.appendChild(canvas);
  return canvas;
}

function pinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.hypot(dx, dy);
}

// ─── Core gesture+render engine ────────────────────────────────────────────
// Adapted from pinch-type by Lucas Crespo (MIT)
// Original: https://github.com/lucascrespo23/pinch-type

/**
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {"pinchType"|"scrollMorph"|"pinchMorph"} opts.mode
 * @returns {Object} instance with setText, resize, destroy, canvas
 */
function createTextCanvas(container, opts = {}) {
  const mode = opts.mode || "pinchType";
  const minFont = opts.minFontSize ?? 8;
  const maxFont = opts.maxFontSize ?? 60;
  const fontFamily = opts.fontFamily ?? '"Inter", system-ui, -apple-system, sans-serif';
  const lhRatio = opts.lineHeight ?? 1.57;
  const padding = opts.padding ?? 28;
  const bg = opts.background ?? "#0a0a0a";
  const textColor = opts.textColor ?? "#e5e5e5";
  const friction = opts.friction ?? 0.95;
  const morphRadius = opts.morphRadius ?? 300;
  const onZoom = opts.onZoom;

  // Mutable state
  let fontSize = opts.fontSize ?? 18;
  let centerSize = opts.centerFontSize ?? 26;
  let edgeSize = opts.edgeFontSize ?? 11;
  const initialRatio = edgeSize / centerSize;

  const canvas = createCanvas(container);
  const ctx = canvas.getContext("2d");
  let dpr = Math.min(devicePixelRatio || 1, 3);
  let W = 0, H = 0;
  let rawText = "";
  let lines = [];
  let totalHeight = 0, maxScroll = 0;
  let scrollY = 0, scrollVelocity = 0;
  let touchLastY = 0, touchLastTime = 0, isTouching = false;
  let pinchActive = false, pinchStartDist = 0;
  let pinchStartSize = 0, pinchStartCenter = 0, pinchStartEdge = 0;
  let raf = 0, destroyed = false;

  // ── Layout (uses Pretext) ──

  function layout() {
    if (!rawText || W === 0) return;
    const maxW = W - padding * 2;
    const fs = mode === "pinchType" ? fontSize : centerSize;
    const lh = fs * lhRatio;
    const font = `400 ${fs}px ${fontFamily}`;
    const paragraphs = rawText.split("\n\n");
    lines = [];
    let curY = padding + 10;
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      ctx.font = font;
      const prepared = prepareWithSegments(trimmed, font);
      const result = layoutWithLines(prepared, maxW, lh);
      for (let li = 0; li < result.lines.length; li++) {
        lines.push({
          text: result.lines[li].text,
          y: curY + li * lh,
          baseSize: fs,
          weight: 400,
        });
      }
      curY += result.lines.length * lh + lh * 0.6;
    }
    totalHeight = curY + padding;
    maxScroll = Math.max(0, totalHeight - H);
    scrollY = clamp(scrollY, 0, maxScroll);
  }

  // ── Render ──

  function render() {
    const d = dpr;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W * d, H * d);
    ctx.textBaseline = "top";

    if (mode === "pinchType") {
      // Uniform text
      ctx.fillStyle = textColor;
      ctx.font = `400 ${fontSize * d}px ${fontFamily}`;
      for (const line of lines) {
        const screenY = line.y - scrollY;
        if (screenY < -100 || screenY > H + 100) continue;
        ctx.fillText(line.text, padding * d, screenY * d);
      }
    } else {
      // Morph (scrollMorph or pinchMorph)
      const viewCenter = H / 2;
      for (const line of lines) {
        const screenY = line.y - scrollY;
        if (screenY < -100 || screenY > H + 100) continue;
        const dist = Math.abs(screenY - viewCenter);
        const t = Math.min(dist / morphRadius, 1);
        const ease = 1 - (1 - t) ** 3;
        const fs = centerSize + (edgeSize - centerSize) * ease;
        const opacity = 1.0 + (0.25 - 1.0) * ease;
        const c = Math.round(255 - (255 - 102) * ease);
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = `rgb(${c},${c},${c})`;
        ctx.font = `${line.weight} ${fs * d}px ${fontFamily}`;
        const yOffset = (fs - line.baseSize) * 0.5;
        ctx.fillText(line.text, padding * d, (screenY - yOffset) * d);
        ctx.restore();
      }
    }
  }

  // ── Animation loop ──

  function loop() {
    if (destroyed) return;
    if (!isTouching) {
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

  // ── Touch handlers ──

  function onTouchStart(e) {
    if (e.touches.length === 2 && mode !== "scrollMorph") {
      pinchActive = true;
      pinchStartDist = pinchDist(e);
      pinchStartSize = fontSize;
      pinchStartCenter = centerSize;
      pinchStartEdge = edgeSize;
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
    if (pinchActive && e.touches.length === 2 && mode !== "scrollMorph") {
      const scale = pinchDist(e) / pinchStartDist;
      if (mode === "pinchType") {
        const newSize = clamp(Math.round(pinchStartSize * scale), minFont, maxFont);
        if (newSize !== fontSize) {
          fontSize = newSize;
          layout();
          onZoom?.(fontSize);
        }
      } else {
        // pinchMorph
        const newCenter = clamp(Math.round(pinchStartCenter * scale), minFont, maxFont);
        const newEdge = clamp(
          Math.round(pinchStartEdge * scale),
          Math.max(minFont, 6),
          Math.round(maxFont * initialRatio)
        );
        if (newCenter !== centerSize || newEdge !== edgeSize) {
          centerSize = newCenter;
          edgeSize = newEdge;
          layout();
          onZoom?.(centerSize, edgeSize);
        }
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
    if ((e.ctrlKey || e.metaKey) && mode !== "scrollMorph") {
      const delta = e.deltaY > 0 ? -1 : 1;
      if (mode === "pinchType") {
        const newSize = clamp(fontSize + delta, minFont, maxFont);
        if (newSize !== fontSize) { fontSize = newSize; layout(); onZoom?.(fontSize); }
      } else {
        const newCenter = clamp(centerSize + delta, minFont, maxFont);
        if (newCenter !== centerSize) {
          centerSize = newCenter;
          edgeSize = clamp(Math.round(centerSize * initialRatio), 4, centerSize);
          layout();
          onZoom?.(centerSize, edgeSize);
        }
      }
    } else {
      scrollY += e.deltaY;
      scrollY = clamp(scrollY, -50, maxScroll + 50);
    }
  }

  function handleResize() {
    dpr = Math.min(devicePixelRatio || 1, 3);
    W = container.clientWidth;
    H = container.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    layout();
  }

  // ── Bind ──

  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", handleResize);
  handleResize();
  raf = requestAnimationFrame(loop);

  return {
    setText(text) {
      rawText = text;
      scrollY = 0;
      scrollVelocity = 0;
      layout();
    },
    resize: handleResize,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", handleResize);
      canvas.remove();
    },
    get canvas() { return canvas; },
  };
}

// ─── PDF integration ───────────────────────────────────────────────────────

/**
 * Create a pinch-type PDF reader.
 *
 * Loads a PDF with pdfjs-dist, extracts text per page, and renders it
 * using pinch-type's Canvas engine with Pretext layout.
 *
 * @param {HTMLElement} container - DOM element (should have width/height)
 * @param {Object} options
 * @param {"pinchType"|"scrollMorph"|"pinchMorph"} [options.mode="pinchType"]
 * @param {string} [options.workerSrc] - pdf.worker URL
 * @param {number} [options.fontSize=18]
 * @param {number} [options.centerFontSize=26]
 * @param {number} [options.edgeFontSize=11]
 * @param {number} [options.minFontSize=8]
 * @param {number} [options.maxFontSize=60]
 * @param {string} [options.fontFamily]
 * @param {number} [options.lineHeight=1.57]
 * @param {number} [options.padding=28]
 * @param {string} [options.background="#0a0a0a"]
 * @param {string} [options.textColor="#e5e5e5"]
 * @param {number} [options.friction=0.95]
 * @param {number} [options.morphRadius=300]
 * @param {Function} [options.onZoom]
 * @param {Function} [options.onPageLoad] - called with { pageNum, text, numPages }
 */
export function createPDFPinchReader(container, options = {}) {
  let pdfjs = null;
  let pdfDoc = null;
  let textInstance = null;
  let currentPage = 0;

  const mode = options.mode || "pinchType";

  async function ensurePdfjs() {
    if (pdfjs) return;
    pdfjs = await import("pdfjs-dist");
    if (options.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
    }
  }

  /**
   * Extract plain text from a PDF page.
   * Joins text items with spaces, preserves paragraph breaks.
   */
  async function extractPageText(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const content = await page.getTextContent();

    // Build text with paragraph detection
    let result = "";
    let lastY = null;
    let lastFontSize = 12;

    for (const item of content.items) {
      if (!item.str) continue;

      if (item.transform) {
        const currentY = item.transform[5];
        const fontHeight = Math.hypot(item.transform[2], item.transform[3]);
        if (fontHeight > 0) lastFontSize = fontHeight;

        if (lastY !== null) {
          const gap = Math.abs(currentY - lastY);
          if (gap > lastFontSize * 1.8) {
            // Paragraph break
            result += "\n\n";
          } else if (gap > lastFontSize * 0.3) {
            // Line break within paragraph — add space
            if (!result.endsWith(" ") && !result.endsWith("\n")) {
              result += " ";
            }
          }
        }
        lastY = currentY;
      }

      result += item.str;
    }

    return result.trim();
  }

  return {
    /**
     * Load a PDF document.
     * @param {string|Uint8Array|ArrayBuffer} source
     * @returns {Promise<{numPages: number}>}
     */
    async open(source) {
      await ensurePdfjs();
      const loadParams =
        source instanceof Uint8Array || source instanceof ArrayBuffer
          ? { data: source }
          : typeof source === "string"
            ? { url: source }
            : source;
      pdfDoc = await pdfjs.getDocument(loadParams).promise;
      return { numPages: pdfDoc.numPages };
    },

    /**
     * Extract text from a page and render it with pinch-type.
     * @param {number} pageNum - 1-based
     * @returns {Promise<{text: string, lineCount: number}>}
     */
    async showPage(pageNum) {
      if (!pdfDoc) throw new Error("Call open() first");
      if (pageNum < 1 || pageNum > pdfDoc.numPages) {
        throw new RangeError(`Page ${pageNum} out of range`);
      }

      const text = await extractPageText(pageNum);
      currentPage = pageNum;

      // Create or reuse the text canvas
      if (!textInstance) {
        textInstance = createTextCanvas(container, { ...options, mode });
      }
      textInstance.setText(text);

      options.onPageLoad?.({
        pageNum,
        text,
        numPages: pdfDoc.numPages,
      });

      return { text };
    },

    /** Show all pages concatenated. */
    async showAll() {
      if (!pdfDoc) throw new Error("Call open() first");
      let allText = "";
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        const pageText = await extractPageText(i);
        if (i > 1) allText += "\n\n";
        allText += pageText;
      }
      if (!textInstance) {
        textInstance = createTextCanvas(container, { ...options, mode });
      }
      textInstance.setText(allText);
      currentPage = -1; // all pages
      return { text: allText };
    },

    /** Go to next page. */
    async nextPage() {
      if (pdfDoc && currentPage > 0 && currentPage < pdfDoc.numPages) {
        return this.showPage(currentPage + 1);
      }
    },

    /** Go to previous page. */
    async prevPage() {
      if (pdfDoc && currentPage > 1) {
        return this.showPage(currentPage - 1);
      }
    },

    /** Resize (auto-called on window resize). */
    resize() {
      textInstance?.resize();
    },

    /** Clean up everything. */
    destroy() {
      textInstance?.destroy();
      textInstance = null;
      pdfDoc?.destroy();
      pdfDoc = null;
    },

    get currentPage() { return currentPage; },
    get numPages() { return pdfDoc?.numPages || 0; },
    get canvas() { return textInstance?.canvas || null; },
    get mode() { return mode; },
  };
}

// Also export the standalone text canvas for non-PDF use
export { createTextCanvas };
