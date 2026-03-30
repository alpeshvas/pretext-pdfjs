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

## Architecture

```
pretext-pdfjs/
├── src/
│   ├── index.js                  # Re-exports pdfjs-dist, swaps TextLayer
│   ├── pretext-text-layer.js     # PretextTextLayer (drop-in replacement)
│   ├── measurement-cache.js      # Pretext-style Canvas measurement cache
│   ├── viewer.js                 # PretextPDFViewer helper
│   └── pinch.js                  # Pinch-type PDF reader integration
├── demo.html                     # Self-contained demo page
├── package.json
└── README.md
```

**Kept from PDF.js** (via `pdfjs-dist` dependency): core parser, canvas renderer, annotation layer, worker architecture, font loading.

**Replaced**: `TextLayer` class — measurement cache, ascent detection, width scaling.

**Added**: `pretextMetrics`, `enableReflow()`, pinch/morph/combined reading modes.

## Built on

- **[@chenglou/pretext](https://github.com/chenglou/pretext)** — DOM-free text measurement & layout by Cheng Lou
- **[pinch-type](https://github.com/lucascrespo23/pinch-type)** — Canvas text effects for mobile by Lucas Crespo
- **[PDF.js](https://github.com/mozilla/pdf.js)** — PDF rendering by Mozilla

## License

MIT
