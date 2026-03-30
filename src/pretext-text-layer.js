/**
 * pretext-pdf: PretextTextLayer
 *
 * Drop-in replacement for pdfjs-dist's TextLayer class.
 *
 * Identical public API:
 *   new PretextTextLayer({ textContentSource, container, viewport })
 *   .render() → Promise<void>
 *   .update({ viewport, onBefore }) → void
 *   .cancel() → void
 *   .textDivs → HTMLElement[]
 *   .textContentItemsStr → string[]
 *   PretextTextLayer.cleanup() → void
 *   PretextTextLayer.fontFamilyMap → Map
 *
 * What changed vs original:
 *   - #layout() uses PretextMeasurementCache.measureWidth() (cached)
 *     instead of raw ctx.measureText() (uncached)
 *   - #getAscent() uses PretextMeasurementCache.getAscentRatio() (cached)
 *     instead of per-font pixel scanning
 *   - #ensureMinFontSizeComputed() is lazily called and minimizes reflow
 *   - All Canvas contexts use OffscreenCanvas when possible
 *   - New: static pretextMetrics getter for profiling
 *   - New: static enableReflow() for Pretext-powered text reflow
 */

import { PretextMeasurementCache } from "./measurement-cache.js";

// ── Singleton measurement cache ────────────────────────────────────────────
const cache = new PretextMeasurementCache();

// ── Helpers imported from pdfjs-dist at runtime ────────────────────────────
let _pdfjs = null;

async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import("pdfjs-dist");
  return _pdfjs;
}

function getPdfjsSync() {
  if (!_pdfjs) throw new Error("Call PretextTextLayer.init() before use");
  return _pdfjs;
}

// ── Lazy Pretext import ────────────────────────────────────────────────────
let _pretext = undefined; // undefined = not attempted, null = unavailable

async function getPretext() {
  if (_pretext !== undefined) return _pretext;
  try {
    _pretext = await import("@chenglou/pretext");
  } catch {
    _pretext = null;
  }
  return _pretext;
}

// ── Constants ──────────────────────────────────────────────────────────────
const MAX_TEXT_DIVS_TO_RENDER = 100000;

// ── PretextTextLayer ───────────────────────────────────────────────────────

class PretextTextLayer {
  #capability = Promise.withResolvers();
  #container = null;
  #disableProcessItems = false;
  #fontInspectorEnabled = !!globalThis.FontInspector?.enabled;
  #lang = null;
  #layoutTextParams = null;
  #pageHeight = 0;
  #pageWidth = 0;
  #reader = null;
  #rootContainer = null;
  #rotation = 0;
  #scale = 0;
  #styleCache = Object.create(null);
  #textContentItemsStr = [];
  #textContentSource = null;
  #textDivs = [];
  #textDivProperties = new WeakMap();
  #transform = null;

  static #pendingTextLayers = new Set();
  static #_fontFamilyMap = null;

  /**
   * Initialize pdfjs-dist dependency. Must be called once before constructing.
   * Alternatively, pass the pdfjs module directly.
   *
   * @param {Object} [pdfjsModule] - pdfjs-dist module (optional, will auto-import if omitted)
   */
  static async init(pdfjsModule) {
    if (pdfjsModule) {
      _pdfjs = pdfjsModule;
    } else {
      await getPdfjs();
    }
  }

  /**
   * @param {Object} options
   * @param {ReadableStream|Object} options.textContentSource
   * @param {HTMLElement} options.container
   * @param {Object} options.viewport - pdfjs-dist PageViewport
   */
  constructor({ textContentSource, container, viewport }) {
    const pdfjs = getPdfjsSync();

    if (textContentSource instanceof ReadableStream) {
      this.#textContentSource = textContentSource;
    } else if (typeof textContentSource === "object") {
      this.#textContentSource = new ReadableStream({
        start(controller) {
          controller.enqueue(textContentSource);
          controller.close();
        },
      });
    } else {
      throw new Error('No "textContentSource" parameter specified.');
    }

    this.#container = this.#rootContainer = container;
    this.#scale = viewport.scale * (globalThis.devicePixelRatio || 1);
    this.#rotation = viewport.rotation;
    this.#layoutTextParams = { div: null, properties: null, ctx: null };

    const { pageWidth, pageHeight, pageX, pageY } = viewport.rawDims;
    this.#transform = [1, 0, 0, -1, -pageX, pageY + pageHeight];
    this.#pageWidth = pageWidth;
    this.#pageHeight = pageHeight;

    // PRETEXT: lazy min font size (computed once, cached)
    const minFontSize = cache.getMinFontSize();

    pdfjs.setLayerDimensions(container, viewport);

    this.#capability.promise
      .finally(() => {
        PretextTextLayer.#pendingTextLayers.delete(this);
        this.#layoutTextParams = null;
        this.#styleCache = null;
      })
      .catch(() => {});
  }

  static get fontFamilyMap() {
    if (this.#_fontFamilyMap) return this.#_fontFamilyMap;
    // Detect platform (same logic as pdfjs-dist)
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isWindows = ua.includes("Windows");
    const isFirefox = ua.includes("Firefox");
    this.#_fontFamilyMap = new Map([
      ["sans-serif", `${isWindows && isFirefox ? "Calibri, " : ""}sans-serif`],
      ["monospace", `${isWindows && isFirefox ? "Lucida Console, " : ""}monospace`],
    ]);
    return this.#_fontFamilyMap;
  }

  /**
   * Render the text layer.
   * @returns {Promise<void>}
   */
  render() {
    const pump = () => {
      this.#reader.read().then(
        ({ value, done }) => {
          if (done) {
            this.#capability.resolve();
            return;
          }
          this.#lang ??= value.lang;
          Object.assign(this.#styleCache, value.styles);
          this.#processItems(value.items);
          pump();
        },
        this.#capability.reject
      );
    };
    this.#reader = this.#textContentSource.getReader();
    PretextTextLayer.#pendingTextLayers.add(this);
    pump();
    return this.#capability.promise;
  }

  /**
   * Update a previously rendered text layer on viewport change.
   * @param {Object} options
   * @param {Object} options.viewport
   * @param {Function} [options.onBefore]
   */
  update({ viewport, onBefore = null }) {
    const pdfjs = getPdfjsSync();
    const scale = viewport.scale * (globalThis.devicePixelRatio || 1);
    const rotation = viewport.rotation;

    if (rotation !== this.#rotation) {
      onBefore?.();
      this.#rotation = rotation;
      pdfjs.setLayerDimensions(this.#rootContainer, { rotation });
    }

    if (scale !== this.#scale) {
      onBefore?.();
      this.#scale = scale;
      // PRETEXT: ctx used for uncached fallback path only
      const ctx = cache.getContext(this.#lang);
      const params = { div: null, properties: null, ctx };
      for (const div of this.#textDivs) {
        params.properties = this.#textDivProperties.get(div);
        params.div = div;
        this.#layout(params);
      }
    }
  }

  /**
   * Cancel rendering.
   */
  cancel() {
    const pdfjs = getPdfjsSync();
    const abortEx = new pdfjs.AbortException("TextLayer task cancelled.");
    this.#reader?.cancel(abortEx).catch(() => {});
    this.#reader = null;
    this.#capability.reject(abortEx);
  }

  /** @type {HTMLElement[]} */
  get textDivs() {
    return this.#textDivs;
  }

  /** @type {string[]} */
  get textContentItemsStr() {
    return this.#textContentItemsStr;
  }

  // ── Internal: process text content stream ────────────────────────────────

  #processItems(items) {
    if (this.#disableProcessItems) return;

    // Ensure we have a Canvas context ready for this batch
    if (!this.#layoutTextParams.ctx) {
      this.#layoutTextParams.ctx = cache.getContext(this.#lang);
    }

    const textDivs = this.#textDivs;
    const textContentItemsStr = this.#textContentItemsStr;

    for (const item of items) {
      if (textDivs.length > MAX_TEXT_DIVS_TO_RENDER) {
        console.warn("pretext-pdf: too many text items, stopping.");
        this.#disableProcessItems = true;
        return;
      }

      if (item.str === undefined) {
        if (
          item.type === "beginMarkedContentProps" ||
          item.type === "beginMarkedContent"
        ) {
          const parent = this.#container;
          this.#container = document.createElement("span");
          this.#container.classList.add("markedContent");
          if (item.id !== null) {
            this.#container.setAttribute("id", `${item.id}`);
          }
          parent.append(this.#container);
        } else if (item.type === "endMarkedContent") {
          this.#container = this.#container.parentNode;
        }
        continue;
      }

      textContentItemsStr.push(item.str);
      this.#appendText(item);
    }
  }

  // ── Internal: append a single text item ──────────────────────────────────

  #appendText(geom) {
    const pdfjs = getPdfjsSync();
    const textDiv = document.createElement("span");
    const textDivProperties = {
      angle: 0,
      canvasWidth: 0,
      hasText: geom.str !== "",
      hasEOL: geom.hasEOL,
      fontSize: 0,
    };
    this.#textDivs.push(textDiv);

    const tx = pdfjs.Util.transform(this.#transform, geom.transform);
    let angle = Math.atan2(tx[1], tx[0]);
    const style = this.#styleCache[geom.fontName];
    if (style.vertical) {
      angle += Math.PI / 2;
    }

    let fontFamily =
      (this.#fontInspectorEnabled && style.fontSubstitution) ||
      style.fontFamily;
    fontFamily = PretextTextLayer.fontFamilyMap.get(fontFamily) || fontFamily;

    const fontHeight = Math.hypot(tx[2], tx[3]);

    // ── PRETEXT CHANGE: cached Canvas ascent (zero DOM reflows) ──
    const fontAscent = fontHeight * cache.getAscentRatio(fontFamily, this.#lang);

    let left, top;
    if (angle === 0) {
      left = tx[4];
      top = tx[5] - fontAscent;
    } else {
      left = tx[4] + fontAscent * Math.sin(angle);
      top = tx[5] - fontAscent * Math.cos(angle);
    }

    const minFontSize = cache.getMinFontSize();
    const scaleFactorStr = "calc(var(--scale-factor)*";
    const divStyle = textDiv.style;

    if (this.#container === this.#rootContainer) {
      divStyle.left = `${((100 * left) / this.#pageWidth).toFixed(2)}%`;
      divStyle.top = `${((100 * top) / this.#pageHeight).toFixed(2)}%`;
    } else {
      divStyle.left = `${scaleFactorStr}${left.toFixed(2)}px)`;
      divStyle.top = `${scaleFactorStr}${top.toFixed(2)}px)`;
    }
    divStyle.fontSize = `${scaleFactorStr}${(minFontSize * fontHeight).toFixed(2)}px)`;
    divStyle.fontFamily = fontFamily;

    textDivProperties.fontSize = fontHeight;
    textDiv.setAttribute("role", "presentation");
    textDiv.textContent = geom.str;
    textDiv.dir = geom.dir;

    if (this.#fontInspectorEnabled) {
      textDiv.dataset.fontName =
        style.fontSubstitutionLoadedName || geom.fontName;
    }
    if (angle !== 0) {
      textDivProperties.angle = angle * (180 / Math.PI);
    }

    let shouldScaleText = false;
    if (geom.str.length > 1) {
      shouldScaleText = true;
    } else if (geom.str !== " " && geom.transform[0] !== geom.transform[3]) {
      const absScaleX = Math.abs(geom.transform[0]);
      const absScaleY = Math.abs(geom.transform[3]);
      if (
        absScaleX !== absScaleY &&
        Math.max(absScaleX, absScaleY) / Math.min(absScaleX, absScaleY) > 1.5
      ) {
        shouldScaleText = true;
      }
    }
    if (shouldScaleText) {
      textDivProperties.canvasWidth = style.vertical ? geom.height : geom.width;
    }
    this.#textDivProperties.set(textDiv, textDivProperties);

    this.#layoutTextParams.div = textDiv;
    this.#layoutTextParams.properties = textDivProperties;
    this.#layout(this.#layoutTextParams);

    if (textDivProperties.hasText) {
      this.#container.append(textDiv);
    }
    if (textDivProperties.hasEOL) {
      const br = document.createElement("br");
      br.setAttribute("role", "presentation");
      this.#container.append(br);
    }
  }

  // ── Internal: layout a single text div ───────────────────────────────────

  #layout(params) {
    const { div, properties, ctx } = params;
    const { style } = div;

    const minFontSize = cache.getMinFontSize();
    let transform = "";
    if (minFontSize > 1) {
      transform = `scale(${1 / minFontSize})`;
    }

    if (properties.canvasWidth !== 0 && properties.hasText) {
      const { fontFamily } = style;
      const { canvasWidth, fontSize } = properties;

      // ── PRETEXT CHANGE: cached measurement ──
      // PDF.js original: ctx.measureText(div.textContent) — uncached
      // Pretext fork: cache.measureWidth() — keyed by (font+text), reused across spans
      const width = cache.measureWidth(
        ctx,
        div.textContent,
        fontSize,
        fontFamily,
        this.#scale
      );

      if (width > 0) {
        transform = `scaleX(${(canvasWidth * this.#scale) / width}) ${transform}`;
      }
    }
    if (properties.angle !== 0) {
      transform = `rotate(${properties.angle}deg) ${transform}`;
    }
    if (transform.length > 0) {
      style.transform = transform;
    }
  }

  // ── Static methods ───────────────────────────────────────────────────────

  /** Clean up global resources. */
  static cleanup() {
    if (this.#pendingTextLayers.size > 0) return;
    cache.cleanup();
  }

  /** Pretext measurement cache metrics for profiling. */
  static get pretextMetrics() {
    return cache.metrics;
  }

  /**
   * Reflow text content using @chenglou/pretext's full layout engine.
   *
   * This is the feature PDF.js cannot offer: take extracted PDF text and
   * re-layout it responsively using Pretext's prepare() + layoutWithLines().
   *
   * @param {HTMLElement} container - Text layer container
   * @param {string} text - Full text content
   * @param {Object} options
   * @param {number} options.width - Target width in px
   * @param {string} options.font - CSS font spec (e.g. '16px Inter')
   * @param {number} options.lineHeight - Line height in px
   * @returns {Promise<{lineCount: number, height: number, lines: Array}>}
   */
  static async enableReflow(container, text, { width, font, lineHeight }) {
    const pretext = await getPretext();
    if (!pretext) {
      throw new Error(
        "@chenglou/pretext is required for reflow mode. " +
          "Install it: npm install @chenglou/pretext"
      );
    }

    const prepared = pretext.prepareWithSegments(text, font);
    const result = pretext.layoutWithLines(prepared, width, lineHeight);

    container.innerHTML = "";
    let y = 0;
    for (const line of result.lines) {
      const lineDiv = document.createElement("div");
      lineDiv.textContent = line.text;
      lineDiv.style.cssText = `
        position: absolute;
        left: 0;
        top: ${y}px;
        font: ${font};
        white-space: pre;
        color: transparent;
        cursor: text;
      `;
      container.append(lineDiv);
      y += lineHeight;
    }

    return {
      lineCount: result.lineCount,
      height: result.height,
      lines: result.lines,
    };
  }
}

export { PretextTextLayer, PretextMeasurementCache, cache as pretextCache };
