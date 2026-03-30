/**
 * pretext-pdf/viewer
 *
 * High-level viewer that uses PretextTextLayer for text overlay.
 * Drop-in for apps that need a simple render-a-page API.
 *
 * Usage:
 *   import { PretextPDFViewer } from "pretext-pdf/viewer";
 *
 *   const viewer = new PretextPDFViewer(containerElement);
 *   await viewer.open("document.pdf");
 *   // or: await viewer.open(uint8Array);
 *   await viewer.renderPage(1);
 *   viewer.setScale(1.5);
 *   await viewer.renderPage(1);
 */

import {
  getDocument,
  GlobalWorkerOptions,
  Util,
  setLayerDimensions,
} from "pdfjs-dist";
import { PretextTextLayer } from "./pretext-text-layer.js";

class PretextPDFViewer {
  /** @type {HTMLElement} */
  #container;

  /** @type {Object|null} pdfjs PDFDocumentProxy */
  #pdfDoc = null;

  /** @type {number} */
  #scale = 1.5;

  /** @type {number} */
  #currentPage = 0;

  /** @type {HTMLCanvasElement} */
  #canvas;

  /** @type {HTMLDivElement} */
  #textLayerDiv;

  /** @type {PretextTextLayer|null} */
  #textLayer = null;

  /** @type {boolean} */
  #initialized = false;

  /**
   * @param {HTMLElement} container - DOM element to render into
   * @param {Object} [options]
   * @param {number} [options.scale=1.5]
   * @param {string} [options.workerSrc] - PDF.js worker URL
   */
  constructor(container, options = {}) {
    this.#container = container;
    this.#scale = options.scale || 1.5;

    if (options.workerSrc) {
      GlobalWorkerOptions.workerSrc = options.workerSrc;
    }

    // Create canvas
    this.#canvas = document.createElement("canvas");
    this.#canvas.style.display = "block";

    // Create text layer overlay
    this.#textLayerDiv = document.createElement("div");
    this.#textLayerDiv.className = "textLayer";
    this.#textLayerDiv.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      right: 0;
      bottom: 0;
      overflow: hidden;
      line-height: 1.0;
    `;

    // Wrapper for positioning
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.display = "inline-block";
    wrapper.append(this.#canvas, this.#textLayerDiv);
    this.#container.append(wrapper);
  }

  /**
   * Open a PDF document.
   * @param {string|URL|Uint8Array|ArrayBuffer} source - URL, typed array, or path
   * @returns {Promise<{numPages: number}>}
   */
  async open(source) {
    // Initialize PretextTextLayer's pdfjs dependency
    if (!this.#initialized) {
      const pdfjs = await import("pdfjs-dist");
      await PretextTextLayer.init(pdfjs);
      this.#initialized = true;
    }

    const loadingTask = getDocument(
      source instanceof Uint8Array || source instanceof ArrayBuffer
        ? { data: source }
        : source
    );
    this.#pdfDoc = await loadingTask.promise;
    return { numPages: this.#pdfDoc.numPages };
  }

  /**
   * Render a specific page.
   * @param {number} pageNum - 1-based page number
   * @returns {Promise<{width: number, height: number, textItems: number, pretextMetrics: Object}>}
   */
  async renderPage(pageNum) {
    if (!this.#pdfDoc) throw new Error("No document loaded. Call open() first.");
    if (pageNum < 1 || pageNum > this.#pdfDoc.numPages) {
      throw new RangeError(`Page ${pageNum} out of range (1-${this.#pdfDoc.numPages})`);
    }

    // Cancel previous text layer
    this.#textLayer?.cancel();

    const page = await this.#pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: this.#scale });
    const outputScale = globalThis.devicePixelRatio || 1;

    // Size canvas
    this.#canvas.width = Math.floor(viewport.width * outputScale);
    this.#canvas.height = Math.floor(viewport.height * outputScale);
    this.#canvas.style.width = `${Math.floor(viewport.width)}px`;
    this.#canvas.style.height = `${Math.floor(viewport.height)}px`;

    // Size wrapper
    const wrapper = this.#canvas.parentElement;
    wrapper.style.width = `${Math.floor(viewport.width)}px`;
    wrapper.style.height = `${Math.floor(viewport.height)}px`;

    // Render canvas
    const ctx = this.#canvas.getContext("2d");
    await page.render({
      canvasContext: ctx,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;

    // Render Pretext text layer
    this.#textLayerDiv.innerHTML = "";

    const textContent = await page.getTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    });

    this.#textLayer = new PretextTextLayer({
      textContentSource: textContent,
      container: this.#textLayerDiv,
      viewport,
    });

    await this.#textLayer.render();

    this.#currentPage = pageNum;

    return {
      width: viewport.width,
      height: viewport.height,
      textItems: this.#textLayer.textContentItemsStr.length,
      pretextMetrics: PretextTextLayer.pretextMetrics,
    };
  }

  /**
   * Set zoom scale.
   * @param {number} scale
   */
  setScale(scale) {
    this.#scale = scale;
  }

  /** @returns {number} */
  get scale() {
    return this.#scale;
  }

  /** @returns {number} */
  get numPages() {
    return this.#pdfDoc?.numPages || 0;
  }

  /** @returns {number} */
  get currentPage() {
    return this.#currentPage;
  }

  /** Get Pretext measurement cache metrics. */
  get pretextMetrics() {
    return PretextTextLayer.pretextMetrics;
  }

  /** Clean up resources. */
  destroy() {
    this.#textLayer?.cancel();
    PretextTextLayer.cleanup();
    this.#pdfDoc?.destroy();
    this.#pdfDoc = null;
    this.#container.innerHTML = "";
  }
}

export { PretextPDFViewer };
