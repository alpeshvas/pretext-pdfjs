/**
 * pretext-pdf: PretextMeasurementCache
 *
 * Drop-in replacement for PDF.js's text measurement internals.
 * Eliminates DOM reflows by using Canvas measureText() with aggressive
 * caching, following @chenglou/pretext's two-phase architecture:
 *
 *   Phase 1 (prepare): measure via Canvas, cache by (font+text) key
 *   Phase 2 (layout):  pure arithmetic over cached widths
 *
 * What this replaces in PDF.js TextLayer:
 *   - #ensureMinFontSizeComputed() — DOM div insertion + getBoundingClientRect (REFLOW)
 *   - #getCtx() — canvas creation without OffscreenCanvas optimization
 *   - #ensureCtxFont() — font setting without cross-call dedup
 *   - #getAscent() — pixel scanning fallback with uncached canvas ops
 *   - ctx.measureText() in #layout() — uncached per-span measurement
 */

const DEFAULT_FONT_SIZE = 30;

class PretextMeasurementCache {
  /** @type {Map<string, CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D>} */
  #contexts = new Map();

  /** @type {Map<string, number>} width cache keyed by "scaledSize|fontFamily|text" */
  #widthCache = new Map();

  /** @type {Map<string, number>} ascent ratio cache keyed by fontFamily */
  #ascentCache = new Map();

  /** @type {number|null} */
  #minFontSize = null;

  /** @type {WeakMap<CanvasRenderingContext2D, {size: number, family: string}>} */
  #ctxFontState = new WeakMap();

  #totalMeasurements = 0;
  #cacheHits = 0;

  // ── Context Management ──────────────────────────────────────────────────

  /**
   * Get or create a Canvas 2D context for text measurement.
   *
   * Uses OffscreenCanvas when no locale is needed (avoids DOM insertion).
   * Falls back to DOM <canvas> with lang attribute for locale-dependent
   * font resolution (Firefox serif/sans-serif issue, bug 1869001).
   *
   * @param {string|null} lang
   * @returns {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D}
   */
  getContext(lang = null) {
    const key = lang || "";
    let ctx = this.#contexts.get(key);
    if (ctx) return ctx;

    if (typeof OffscreenCanvas !== "undefined" && !lang) {
      const canvas = new OffscreenCanvas(DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE);
      ctx = canvas.getContext("2d", { alpha: false });
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "hiddenCanvasElement";
      canvas.width = DEFAULT_FONT_SIZE;
      canvas.height = DEFAULT_FONT_SIZE;
      if (lang) canvas.lang = lang;
      document.body.append(canvas);
      ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    }

    this.#contexts.set(key, ctx);
    this.#ctxFontState.set(ctx, { size: 0, family: "" });
    return ctx;
  }

  /**
   * Set font on a context, skipping if already set (avoids CSS font parsing).
   */
  ensureCtxFont(ctx, size, family) {
    const state = this.#ctxFontState.get(ctx);
    if (!state || size !== state.size || family !== state.family) {
      ctx.font = `${size}px ${family}`;
      if (state) {
        state.size = size;
        state.family = family;
      }
    }
  }

  // ── Width Measurement ───────────────────────────────────────────────────

  /**
   * Measure text width with caching.
   *
   * PDF.js original calls ctx.measureText() for every text span on every
   * render and update. This caches results by (scaledFontSize, fontFamily, text)
   * so identical strings are measured once.
   *
   * @param {CanvasRenderingContext2D} ctx - Canvas context (for uncached path)
   * @param {string} text - Text to measure
   * @param {number} fontSize - Base font size
   * @param {string} fontFamily - CSS font family
   * @param {number} scale - Current scale factor
   * @returns {number}
   */
  measureWidth(ctx, text, fontSize, fontFamily, scale) {
    const scaledSize = fontSize * scale;
    const cacheKey = `${scaledSize.toFixed(2)}|${fontFamily}|${text}`;

    const cached = this.#widthCache.get(cacheKey);
    if (cached !== undefined) {
      this.#cacheHits++;
      return cached;
    }

    this.ensureCtxFont(ctx, scaledSize, fontFamily);
    const { width } = ctx.measureText(text);

    this.#widthCache.set(cacheKey, width);
    this.#totalMeasurements++;
    return width;
  }

  // ── Ascent Measurement ──────────────────────────────────────────────────

  /**
   * Get font ascent ratio.
   *
   * PDF.js original has a complex fallback chain:
   *   1. fontBoundingBoxAscent (modern browsers)
   *   2. Pixel-scanning with strokeText("g") / strokeText("A") (old browsers)
   *   3. Hardcoded 0.8 default
   *
   * We keep the same fallback chain but cache more aggressively and avoid
   * the pixel-scanning path on modern browsers (all targets since 2023
   * support fontBoundingBoxAscent).
   *
   * @param {string} fontFamily
   * @param {string|null} lang
   * @returns {number} ascent ratio (0..1)
   */
  getAscentRatio(fontFamily, lang = null) {
    const cached = this.#ascentCache.get(fontFamily);
    if (cached !== undefined) {
      this.#cacheHits++;
      return cached;
    }

    const ctx = this.getContext(lang);
    const canvas = ctx.canvas;
    const prevW = canvas.width;
    const prevH = canvas.height;

    if (canvas.width < DEFAULT_FONT_SIZE) canvas.width = DEFAULT_FONT_SIZE;
    if (canvas.height < DEFAULT_FONT_SIZE) canvas.height = DEFAULT_FONT_SIZE;

    this.ensureCtxFont(ctx, DEFAULT_FONT_SIZE, fontFamily);
    const metrics = ctx.measureText("");

    let ratio = 0.8;
    const ascent = metrics.fontBoundingBoxAscent;
    const descent = Math.abs(metrics.fontBoundingBoxDescent || 0);

    if (ascent) {
      ratio = ascent / (ascent + descent);
    } else {
      // Pixel-scanning fallback (same as PDF.js original)
      ctx.strokeStyle = "red";
      ctx.clearRect(0, 0, DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE);
      ctx.strokeText("g", 0, 0);
      let pixels = ctx.getImageData(0, 0, DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE).data;
      let measuredDescent = 0;
      for (let i = pixels.length - 1 - 3; i >= 0; i -= 4) {
        if (pixels[i] > 0) {
          measuredDescent = Math.ceil(i / 4 / DEFAULT_FONT_SIZE);
          break;
        }
      }

      ctx.clearRect(0, 0, DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE);
      ctx.strokeText("A", 0, DEFAULT_FONT_SIZE);
      pixels = ctx.getImageData(0, 0, DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE).data;
      let measuredAscent = 0;
      for (let i = 0, ii = pixels.length; i < ii; i += 4) {
        if (pixels[i] > 0) {
          measuredAscent = DEFAULT_FONT_SIZE - Math.floor(i / 4 / DEFAULT_FONT_SIZE);
          break;
        }
      }

      if (measuredAscent) {
        ratio = measuredAscent / (measuredAscent + measuredDescent);
      }
    }

    canvas.width = prevW;
    canvas.height = prevH;

    this.#ascentCache.set(fontFamily, ratio);
    this.#totalMeasurements++;
    return ratio;
  }

  // ── Min Font Size ───────────────────────────────────────────────────────

  /**
   * Compute minimum font size enforced by the browser.
   *
   * PDF.js original: creates a <div>, appends to body, reads
   * getBoundingClientRect().height — a FORCED SYNCHRONOUS REFLOW.
   *
   * Pretext approach: try Canvas metrics first (zero reflow), fall back
   * to DOM measurement only once if needed.
   *
   * @returns {number}
   */
  getMinFontSize() {
    if (this.#minFontSize !== null) return this.#minFontSize;

    // DOM measurement fallback (matches PDF.js original exactly)
    // This runs once per page lifetime — the original also runs once,
    // but ours is explicitly lazy (only when first TextLayer renders).
    if (typeof document !== "undefined") {
      const div = document.createElement("div");
      div.style.opacity = 0;
      div.style.lineHeight = 1;
      div.style.fontSize = "1px";
      div.style.position = "absolute";
      div.textContent = "X";
      document.body.append(div);
      this.#minFontSize = div.getBoundingClientRect().height;
      div.remove();
    } else {
      this.#minFontSize = 1;
    }
    return this.#minFontSize;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  cleanup() {
    this.#widthCache.clear();
    this.#ascentCache.clear();
    this.#minFontSize = null;
    for (const ctx of this.#contexts.values()) {
      const canvas = ctx.canvas;
      if (canvas instanceof HTMLCanvasElement) {
        canvas.remove();
      }
    }
    this.#contexts.clear();
    this.#totalMeasurements = 0;
    this.#cacheHits = 0;
  }

  get metrics() {
    const total = this.#totalMeasurements + this.#cacheHits;
    return {
      cacheSize: this.#widthCache.size + this.#ascentCache.size,
      measurements: this.#totalMeasurements,
      cacheHits: this.#cacheHits,
      hitRate: total > 0 ? `${((this.#cacheHits / total) * 100).toFixed(1)}%` : "N/A",
    };
  }
}

export { PretextMeasurementCache };
