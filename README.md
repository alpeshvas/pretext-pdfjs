# pretext-pdfjs

Pretext-native text layer for PDF.js.

*Use PDF.js for parsing and rendering. Use pretext-pdfjs for the text layer.*

**[npm](https://www.npmjs.com/package/pretext-pdfjs)**

---

## What this is

PDF.js has no plugin system — but its layered API means you can use the parser and canvas renderer while bringing your own text layer. That's what this library does.

pretext-pdfjs replaces the text layer with one built on [@chenglou/pretext](https://github.com/chenglou/pretext)'s zero-reflow measurement engine, and adds [pinch-type](https://github.com/lucascrespo23/pinch-type) reading modes. 1,528 lines. Not a fork — a companion library.

## Why

| | PDF.js original | pretext-pdfjs |
|---|---|---|
| **Min font size** | `createElement` → `append` → `getBoundingClientRect` (reflow) | Canvas metrics (zero reflow) |
| **Font ascent** | Pixel scanning fallback | `fontBoundingBoxAscent` + cache |
| **Text width** | `measureText()` per span, uncached | Cached by `(font\|text)` key |
| **Canvas context** | DOM `<canvas>` in body | `OffscreenCanvas` when available |
| **Pinch-to-zoom** | Zooms the page | Resizes and reflows text |
| **Reflow** | Not possible | `enableReflow()` via Pretext |

## Install

```bash
npm install pretext-pdfjs
```

## Usage

### Drop-in replacement

```js
// Before:
import { getDocument, TextLayer } from "pdfjs-dist";

// After — same API:
import { getDocument, TextLayer } from "pretext-pdfjs";
```

### Pinch-to-zoom PDF reader

```js
import { createPDFPinchReader } from "pretext-pdfjs/pinch";

const reader = createPDFPinchReader(container, {
  mode: "pinchMorph",  // or "pinchType" or "scrollMorph"
});
await reader.open("document.pdf");
await reader.showPage(1);
```

### Three reading modes

- **`pinchType`** — pinch/ctrl+scroll resizes text uniformly, Pretext reflows at new size
- **`scrollMorph`** — fisheye: center text large and bright, edges small and dim
- **`pinchMorph`** — both combined

### Measurement metrics

```js
import { TextLayer } from "pretext-pdfjs";

// After rendering:
console.log(TextLayer.pretextMetrics);
// { cacheSize: 142, measurements: 89, cacheHits: 53, hitRate: "37.3%" }
```

### Text reflow

```js
import { TextLayer } from "pretext-pdfjs";

const textContent = await page.getTextContent();
const fullText = textContent.items.map(i => i.str).filter(Boolean).join(" ");

await TextLayer.enableReflow(container, fullText, {
  width: 600,
  font: '16px "Palatino Linotype", serif',
  lineHeight: 24,
});
```

### Reflow Mode (images preserved)

```js
import { createReflowRenderer } from "pretext-pdfjs/reflow";

const renderer = createReflowRenderer(container, {
  fontSize: 16,
  enablePinchZoom: true,
  enableMorph: false,           // set true for fisheye scroll
  fontFamily: '"Literata", Georgia, serif',
});
await renderer.open("document.pdf");
await renderer.showPage(1);
// Pinch to zoom — text reflows, images stay in place
```

Unlike the text-only reader modes, reflow mode preserves images, vector graphics,
and document structure. It uses PDF.js's `operationsFilter` to render non-text
elements separately, then composites Pretext-reflowed text on top.

### Pinch reader with preserved layout

```js
import { createPDFPinchReader } from "pretext-pdfjs/pinch";

const reader = createPDFPinchReader(container, {
  mode: "pinchType",
  preserveLayout: true,  // images stay in place
});
await reader.open("document.pdf");
await reader.showPage(1);
```

### Per-block reflow (full options)

The reflow module bridges PDF mode (images preserved, no reflow) and reader modes (text reflows, images stripped). Text blocks reflow with Pretext at the target font size while images and vector graphics render as scaled bitmaps in their original positions.

```js
import { createReflowRenderer } from "pretext-pdfjs/reflow";

const renderer = createReflowRenderer(container, {
  fontSize: 16,
  fontFamily: '"Literata", Georgia, serif',
  lineHeight: 1.6,
  padding: 24,
  background: "#f4f1eb",
  textColor: "#252320",
  imageFit: "proportional",  // "proportional" | "original" | "full-width"
  maxWidth: Infinity,        // max canvas width (default: full container)
  enablePinchZoom: true,
  enableMomentumScroll: true,
  enableMorph: false,        // fisheye scroll effect on text + images
  morphRadius: 300,          // morph effect radius in px
  edgeFontRatio: 0.5,       // edge font = 50% of center font
  onZoom: (fontSize) => console.log("Font size:", fontSize),
  onPageReady: ({ pageNum, textBlocks, graphicRegions }) => {
    console.log(`Page ${pageNum}: ${textBlocks.length} text blocks, ${graphicRegions.length} graphics`);
  },
});

await renderer.open("document.pdf");
await renderer.showPage(1);        // single page
// or: await renderer.showAll();   // all pages concatenated

renderer.nextPage();
renderer.prevPage();

// Read-only properties
renderer.currentPage;   // number
renderer.numPages;       // number
renderer.canvas;         // HTMLCanvasElement
renderer.regions;        // { text: [...], graphic: [...] }

renderer.destroy();
```

**How it works:**

1. **Analyze** — extracts text blocks (grouped by proximity) and graphic regions (images, vector paths) from the PDF page via `getTextContent()` and `getOperatorList()`. Uses `operationsFilter` to render only non-text content to an offscreen canvas, and `recordImages` for precise image coordinates.
2. **Reflow** — each text block is reflowed with Pretext's `prepareWithSegments()` + `layoutWithLines()` at the current font size. Graphic bitmaps are scaled proportionally.
3. **Composite** — walks the region map in reading order, drawing reflowed text lines and graphic bitmaps onto a single output canvas. With `enableMorph`, applies fisheye interpolation to both text and images.

Steps 1 runs once per page (cached). Steps 2-3 re-run on font size change, which is what makes pinch-to-zoom fast.

## Architecture

```
pretext-pdfjs/
├── src/
│   ├── index.js                  # Re-exports pdfjs-dist, swaps TextLayer
│   ├── pretext-text-layer.js     # PretextTextLayer (drop-in replacement)
│   ├── measurement-cache.js      # Pretext-style Canvas measurement cache
│   ├── viewer.js                 # PretextPDFViewer helper
│   ├── pinch.js                  # Pinch-type reading modes
│   └── reflow.js                 # Per-block reflow with image preservation
├── demo.html                     # Library landing page
├── reader.html                   # Full PDF reader demo
├── package.json
└── README.md
```

**Kept from PDF.js**: core parser, canvas renderer, annotation layer, worker, font loading.

**Replaced**: TextLayer — measurement cache, ascent detection, width scaling.

**Added**: pretextMetrics, enableReflow(), pinch/morph reading modes, per-block reflow with image preservation.

## Built on

- **[@chenglou/pretext](https://github.com/chenglou/pretext)** — DOM-free text measurement & layout by Cheng Lou
- **[pinch-type](https://github.com/lucascrespo23/pinch-type)** — Canvas text effects for mobile by Lucas Crespo
- **[PDF.js](https://github.com/mozilla/pdf.js)** — PDF rendering by Mozilla

## License

MIT
