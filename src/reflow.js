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

/**
 * Draw a line of text with justified spacing (equal space between words).
 */
function drawJustifiedLine(ctx, text, x, y, availWidth) {
  const words = text.split(" ");
  if (words.length <= 1) {
    ctx.fillText(text, x, y);
    return;
  }
  let totalWordWidth = 0;
  for (const w of words) totalWordWidth += ctx.measureText(w).width;

  const normalSpaceWidth = ctx.measureText(" ").width;
  const extraSpace = (availWidth - totalWordWidth) / (words.length - 1);

  // Fall back to left-aligned if gaps would be too large
  if (extraSpace > normalSpaceWidth * 3 || totalWordWidth < availWidth * 0.7) {
    ctx.fillText(text, x, y);
    return;
  }

  let xPos = x;
  for (const w of words) {
    ctx.fillText(w, xPos, y);
    xPos += ctx.measureText(w).width + extraSpace;
  }
}

/**
 * Draw a line of text with per-span coloring (for inline colored text like links).
 */
function drawColoredLine(ctx, text, charOffset, spans, defaultColor, x, y) {
  const lineStart = charOffset;
  const lineEnd = charOffset + text.length;
  let xPos = x;
  let pos = 0;

  for (const span of spans) {
    if (span.charEnd <= lineStart || span.charStart >= lineEnd) continue;
    const overlapStart = Math.max(span.charStart - lineStart, 0);
    const overlapEnd = Math.min(span.charEnd - lineStart, text.length);

    if (overlapStart > pos) {
      const gapText = text.slice(pos, overlapStart);
      ctx.fillStyle = defaultColor;
      ctx.fillText(gapText, xPos, y);
      xPos += ctx.measureText(gapText).width;
    }

    const spanText = text.slice(overlapStart, overlapEnd);
    ctx.fillStyle = span.color === "transparent" ? defaultColor : span.color;
    ctx.fillText(spanText, xPos, y);
    xPos += ctx.measureText(spanText).width;
    pos = overlapEnd;
  }

  if (pos < text.length) {
    ctx.fillStyle = defaultColor;
    ctx.fillText(text.slice(pos), xPos, y);
  }
}

/**
 * Draw a line of justified text with per-span coloring.
 */
function drawColoredJustifiedLine(ctx, text, charOffset, spans, defaultColor, x, y, availWidth) {
  const words = text.split(" ");
  if (words.length <= 1) {
    drawColoredLine(ctx, text, charOffset, spans, defaultColor, x, y);
    return;
  }
  let totalWordWidth = 0;
  for (const w of words) totalWordWidth += ctx.measureText(w).width;
  const normalSpaceWidth = ctx.measureText(" ").width;
  const extraSpace = (availWidth - totalWordWidth) / (words.length - 1);

  if (extraSpace > normalSpaceWidth * 3 || totalWordWidth < availWidth * 0.7) {
    drawColoredLine(ctx, text, charOffset, spans, defaultColor, x, y);
    return;
  }

  // Draw word by word with per-span coloring and justified spacing
  let xPos = x;
  let charPos = 0;
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi];
    drawColoredLine(ctx, word, charOffset + charPos, spans, defaultColor, xPos, y);
    xPos += ctx.measureText(word).width + extraSpace;
    charPos += word.length + 1; // +1 for space
  }
}

/**
 * Draw a line of text with per-segment font style switching (bold/italic transitions).
 */
function drawStyledLine(ctx, text, charOffset, segments, baseFontSize, fontFamily, dpr, defaultColor, x, y) {
  const lineStart = charOffset;
  const lineEnd = charOffset + text.length;
  let xPos = x;
  let pos = 0;

  for (const seg of segments) {
    if (seg.charEnd <= lineStart || seg.charStart >= lineEnd) continue;
    const overlapStart = Math.max(seg.charStart - lineStart, 0);
    const overlapEnd = Math.min(seg.charEnd - lineStart, text.length);

    // Draw any gap before this segment with default style
    if (overlapStart > pos) {
      const gapText = text.slice(pos, overlapStart);
      ctx.fillText(gapText, xPos, y);
      xPos += ctx.measureText(gapText).width;
    }

    const segText = text.slice(overlapStart, overlapEnd);
    const weight = seg.bold ? 700 : 400;
    const style = seg.italic ? "italic" : "normal";
    ctx.font = `${style} ${weight} ${baseFontSize * dpr}px ${fontFamily}`;
    ctx.fillStyle = defaultColor;
    ctx.fillText(segText, xPos, y);
    xPos += ctx.measureText(segText).width;
    pos = overlapEnd;
  }

  if (pos < text.length) {
    ctx.fillText(text.slice(pos), xPos, y);
  }
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

// ─── Font metadata extraction ────────────────────────────────────────────

/**
 * Extract real font metadata (bold, italic, weight, loadedName) from
 * page.commonObjs. Must be called AFTER page.render() so fonts are loaded.
 */
async function extractFontMetadata(page, opList, OPS) {
  const fontMap = new Map();

  for (let i = 0; i < opList.fnArray.length; i++) {
    if (opList.fnArray[i] === OPS.setFont) {
      const fontRefName = opList.argsArray[i][0];
      if (fontMap.has(fontRefName)) continue;

      try {
        const fontObj = page.commonObjs.get(fontRefName);
        if (fontObj) {
          fontMap.set(fontRefName, {
            bold: fontObj.bold || false,
            black: fontObj.black || false,
            italic: fontObj.italic || false,
            loadedName: fontObj.loadedName || null,
            fallbackName: fontObj.fallbackName || "sans-serif",
            css: fontObj.systemFontInfo?.css || null,
            isMonospace: fontObj.isMonospace || false,
            isSerifFont: fontObj.isSerifFont || false,
          });
        }
      } catch (_) {
        // Font not yet loaded — skip
      }
    }
  }
  return fontMap;
}

// ─── Text color extraction ───────────────────────────────────────────────

/**
 * Extract text with colors from the operator list.
 * Returns an array of {text, color} objects that can be matched to getTextContent() items.
 */
function extractTextWithColors(opList, OPS) {
  const textRuns = []; // {text, color}
  let fillColor = "#000000";
  let strokeColor = "#000000";
  let textRenderingMode = 0;

  // Helper to extract text from glyph array
  function glyphsToText(glyphs) {
    if (!Array.isArray(glyphs)) return "";
    return glyphs
      .filter(g => g && typeof g === "object" && g.unicode)
      .map(g => g.unicode)
      .join("");
  }

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

    if (fn === OPS.setFillRGBColor) {
      fillColor = argsToHex(args);
    } else if (fn === OPS.setStrokeRGBColor) {
      strokeColor = argsToHex(args);
    } else if (fn === OPS.setTextRenderingMode) {
      textRenderingMode = args[0];
    } else if (fn === OPS.showText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      const text = glyphsToText(args[0]);
      if (text) {
        textRuns.push({ text, color: visibleColor(fillColor, strokeColor, textRenderingMode) });
      }
    } else if (fn === OPS.showSpacedText) {
      // showSpacedText has an array of [glyphs, spacing, glyphs, spacing, ...]
      const arr = args[0];
      if (Array.isArray(arr)) {
        let combinedText = "";
        for (let j = 0; j < arr.length; j += 2) {
          const glyphs = arr[j];
          if (glyphs) {
            combinedText += glyphsToText(glyphs);
          }
        }
        if (combinedText) {
          textRuns.push({ text: combinedText, color: visibleColor(fillColor, strokeColor, textRenderingMode) });
        }
      }
    }
  }

  return textRuns;
}

/**
 * Match text items to colors by content.
 * Returns an array of colors aligned with textItems.
 */
function matchColorsToTextItems(textItems, textRuns) {
  const colors = [];
  let runIdx = 0;

  for (const item of textItems) {
    if (item.str === undefined || !item.str.trim()) {
      colors.push(null); // Skip non-text items
      continue;
    }

    const itemText = item.str.trim();
    let matchedColor = "#000000"; // default

    // Find a text run that matches this item
    // Reset runIdx if we've gone too far (item may be earlier in the list)
    if (runIdx >= textRuns.length) {
      runIdx = 0;
    }

    // Search for matching run starting from current position
    for (let i = runIdx; i < textRuns.length; i++) {
      const run = textRuns[i];
      const runText = run.text.trim();

      // Skip empty runs
      if (!runText) continue;

      // Check for exact match or substring match
      if (runText === itemText || 
          itemText.startsWith(runText) || 
          runText.startsWith(itemText)) {
        matchedColor = run.color;
        runIdx = i + 1; // Start from next run for next item
        break;
      }
    }

    colors.push(matchedColor);
  }

  return colors;
}

/**
 * Extract one visible color per text-drawing operator in the operator list.
 * Returns an array that maps ~1:1 to the text items from getTextContent().
 * DEPRECATED: Use extractTextWithColors + matchColorsToTextItems instead.
 */
function extractTextItemColors(opList, OPS) {
  const itemColors = []; // one entry per text-drawing operator
  let fillColor = "#000000";
  let strokeColor = "#000000";
  let textRenderingMode = 0;

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];

    if (fn === OPS.setFillRGBColor) {
      fillColor = argsToHex(opList.argsArray[i]);
    } else if (fn === OPS.setStrokeRGBColor) {
      strokeColor = argsToHex(opList.argsArray[i]);
    } else if (fn === OPS.setTextRenderingMode) {
      textRenderingMode = opList.argsArray[i][0];
    } else if (
      fn === OPS.showText ||
      fn === OPS.nextLineShowText ||
      fn === OPS.nextLineSetSpacingShowText
    ) {
      itemColors.push(visibleColor(fillColor, strokeColor, textRenderingMode));
    } else if (fn === OPS.showSpacedText) {
      itemColors.push(visibleColor(fillColor, strokeColor, textRenderingMode));
    }
  }

  return itemColors;
}

/** Convert color operator args to a hex string. Args may be a hex string or RGB byte array. */
function argsToHex(args) {
  if (typeof args[0] === "string" && args[0].startsWith("#")) return args[0];
  const r = args[0] | 0, g = args[1] | 0, b = args[2] | 0;
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Pick the color that will actually be visible based on text rendering mode. */
function visibleColor(fill, stroke, mode) {
  const m = mode & 3; // lower 2 bits: 0=fill, 1=stroke, 2=fill+stroke, 3=invisible
  if (m === 1) return stroke;
  if (m === 0 || m === 2) return fill;
  return "#000000"; // mode 3 (invisible) — show as black in reflow
}

// ─── Page analysis ────────────────────────────────────────────────────────

/**
 * Find adaptive threshold for grouping items into blocks.
 * Similar to paragraph detection but tuned for block-level grouping.
 */
function findBlockThreshold(gaps, fontSize) {
  if (gaps.length < 3) return 2.0;  // Default block threshold

  // Filter extreme outliers
  const filtered = gaps.filter(g => g / fontSize < 5);
  if (filtered.length < 3) return 2.0;

  const ratios = filtered.map(g => g / fontSize).sort((a, b) => a - b);

  // For block grouping, we want to be more conservative than paragraph detection
  // Use the 60th percentile as the threshold - this separates:
  // - Line spacing (~1.0-1.3x) from paragraph gaps (~1.5x+)
  const idx = Math.floor(ratios.length * 0.6);
  const threshold = ratios[Math.min(idx, ratios.length - 1)];

  // Clamp: block threshold should be between 1.5x and 2.2x
  // Lower than paragraph threshold to ensure paragraphs split into separate blocks
  return Math.max(1.5, Math.min(threshold, 2.2));
}

/**
 * Group adjacent text items into text blocks by proximity.
 * Also extracts font metadata: average size, italic, bold.
 */
function groupTextBlocks(textItems, pageHeight, styles, fontMap, textRuns) {
  // Assign colors to text items by matching content from textRuns.
  // textRuns is an array of {text, color} extracted from the operator list.
  if (textRuns && textRuns.length > 0) {
    const colors = matchColorsToTextItems(textItems, textRuns);
    for (let i = 0; i < textItems.length; i++) {
      const item = textItems[i];
      if (item.str === undefined || !item.str.trim()) continue;
      item._color = colors[i] || "#000000";
    }
  }

  const sorted = [...textItems].filter(i => i.str?.trim()).sort((a, b) => {
    const ay = pageHeight - a.transform[5];
    const by = pageHeight - b.transform[5];
    if (Math.abs(ay - by) > 2) return ay - by;
    return a.transform[4] - b.transform[4];
  });

  // First pass: collect all vertical gaps to compute adaptive block threshold
  const gaps = [];
  let lastY = null;
  let lastFontSize = 12;
  for (const item of sorted) {
    const y = pageHeight - item.transform[5];
    const fontHeight = Math.hypot(item.transform[2], item.transform[3]);
    if (fontHeight > 0) lastFontSize = fontHeight;
    if (lastY !== null) {
      gaps.push(Math.abs(y - lastY));
    }
    lastY = y;
  }

  // Compute adaptive block grouping threshold
  const blockThreshold = findBlockThreshold(gaps, lastFontSize);

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
    // But don't split for superscripts/markers that are horizontally adjacent
    const sizeRatio = fontHeight > 0 && lastFH > 0
      ? Math.max(fontHeight, lastFH) / Math.min(fontHeight, lastFH)
      : 1;
    const lastX = lastItem.transform[4];
    const lastItemStr = (lastItem.str || "");
    const lastW = lastItem.width || (lastFH * 0.55 * lastItemStr.length) || lastFH;
    const hGap = x - (lastX + lastW);
    const isHorizAdjacent = hGap < lastFH * 0.8 && hGap > -lastFH;
    const itemText = (item.str || "").trim();
    const isShortItem = itemText.length <= 2;
    // Superscript detection: small item adjacent to larger text with size difference
    const isSuperscript = isShortItem && isHorizAdjacent && sizeRatio > 1.3;
    // Also detect subscript (marker after text, smaller font)
    const isSubscript = isShortItem && isHorizAdjacent && sizeRatio > 1.1 && hGap < lastFH * 0.3;
    const sizeOk = sizeRatio < 1.3 || isSuperscript || isSubscript;

    // Large horizontal gap between consecutive items → likely column break
    // Only for substantive text (skip short items like superscript markers)
    const isLongItem = (item.str || "").trim().length > 3;
    if (isLongItem && (hGap > lastFH * 1.5 ||
        (current.bbox.w > lastFH * 10 && x < current.bbox.x - lastFH * 3))) {
      blocks.push(current);
      current = { items: [item], bbox: { x, y, w: item.width || 0, h: fontHeight } };
      continue;
    }

    // Use adaptive block threshold instead of fixed 2.5x
    if (
      sizeOk &&
      verticalGap < lastFH * blockThreshold &&
      x < current.bbox.x + current.bbox.w + lastFH * 1.5
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

  // Post-process: merge orphan tiny blocks (superscripts, markers like *, +, #)
  // into the nearest larger block if vertically close AND horizontally aligned
  // IMPROVED: Better handling of footnote/superscript markers
  const MARKER_CHARS = /^[*+†‡#$§¶]$/;
  
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.items.length > 2) continue;
    const text = block.items.map(it => (it.str || "").trim()).join("");
    // Only merge marker-only blocks (1-2 chars, typically footnote symbols)
    if (text.length > 2 || text.length === 0) continue;
    // Must be a marker character or short symbol
    const isMarker = text.split("").every(c => MARKER_CHARS.test(c) || c === "," || c === " ");
    if (!isMarker && text.length > 1) continue;

    let bestIdx = -1, bestDist = Infinity;
    let bestScore = -Infinity;
    
    for (let j = 0; j < blocks.length; j++) {
      if (j === i) continue;
      const o = blocks[j];
      // Skip other orphans (short text blocks)
      const oText = o.items.map(it => (it.str || "").trim()).join("");
      if (oText.length <= 3) continue;
      
      // Check vertical proximity: orphan center within 30pt of target block
      const bcy = block.bbox.y + block.bbox.h / 2;
      if (bcy < o.bbox.y - 30 || bcy > o.bbox.y + o.bbox.h + 30) continue;
      
      // Prefer blocks that are BEFORE this marker (markers attach to preceding text)
      const blockIsBefore = o.bbox.y + o.bbox.h <= block.bbox.y + 5;
      const blockIsAfter = o.bbox.y >= block.bbox.y + block.bbox.h - 5;
      
      // Horizontal position check - marker should be near the END of preceding text
      // or at similar X position as text in the same line
      const markerCenterX = block.bbox.x + block.bbox.w / 2;
      const targetRight = o.bbox.x + o.bbox.w;
      const targetLeft = o.bbox.x;
      
      // Score based on horizontal proximity to end of target text
      let hScore = 0;
      if (markerCenterX >= targetLeft && markerCenterX <= targetRight + block.bbox.w * 3) {
        // Marker is within or near the target block's horizontal span
        hScore = 10;
      } else if (Math.abs(markerCenterX - targetRight) < block.bbox.w * 5) {
        // Marker is close to the right edge of target
        hScore = 5;
      }
      
      // Prefer preceding blocks (superscripts come after text)
      const vScore = blockIsBefore ? 20 : blockIsAfter ? 5 : 10;
      const score = hScore + vScore;
      
      // Horizontal edge-to-edge distance
      const hDist = blockIsBefore 
        ? Math.abs(block.bbox.x - targetRight)  // Distance from marker left to target right
        : Math.max(0,
            block.bbox.x > o.bbox.x + o.bbox.w ? block.bbox.x - (o.bbox.x + o.bbox.w) :
            o.bbox.x > block.bbox.x + block.bbox.w ? o.bbox.x - (block.bbox.x + block.bbox.w) : 0);
      
      if (score > bestScore || (score === bestScore && hDist < bestDist)) {
        bestScore = score;
        bestDist = hDist;
        bestIdx = j;
      }
    }

    // Merge if found a suitable parent block
    if (bestIdx >= 0 && (bestScore >= 15 || bestDist < Math.max(blocks[bestIdx].bbox.h, 20))) {
      const target = blocks[bestIdx];
      target.items.push(...block.items);
      // Re-sort items by X position to maintain correct order
      target.items.sort((a, b) => a.transform[4] - b.transform[4]);
      const newX = Math.min(target.bbox.x, block.bbox.x);
      const newRight = Math.max(target.bbox.x + target.bbox.w, block.bbox.x + block.bbox.w);
      const newBottom = Math.max(target.bbox.y + target.bbox.h, block.bbox.y + block.bbox.h);
      target.bbox.x = newX;
      target.bbox.w = newRight - newX;
      target.bbox.h = newBottom - target.bbox.y;
      blocks.splice(i, 1);
    }
  }

  // Post-process: detect multi-column grids (like author sections)
  // Group blocks that form aligned columns into a single composite block
  const multiColumnBlocks = [];
  const processed = new Set();
  
  for (let i = 0; i < blocks.length; i++) {
    if (processed.has(i)) continue;
    const block = blocks[i];
    const blockText = block.items.map(it => (it.str || "").trim()).join(" ");
    const blockCenterX = block.bbox.x + block.bbox.w / 2;
    
    // Find all blocks in same horizontal band (similar Y position)
    const sameRowBlocks = [block];
    const rowY = block.bbox.y;
    const rowH = block.bbox.h;
    
    for (let j = i + 1; j < blocks.length; j++) {
      if (processed.has(j)) continue;
      const other = blocks[j];
      // Check if in same row (vertical overlap)
      const yOverlap = Math.max(0, Math.min(rowY + rowH, other.bbox.y + other.bbox.h) - Math.max(rowY, other.bbox.y));
      const minH = Math.min(rowH, other.bbox.h);
      if (yOverlap > minH * 0.5) {
        sameRowBlocks.push(other);
      }
    }
    
    // If we have multiple blocks in same row, this might be a multi-column layout
    if (sameRowBlocks.length >= 2) {
      // Sort by X position
      sameRowBlocks.sort((a, b) => a.bbox.x - b.bbox.x);
      // Check if they're roughly aligned (similar height, spaced evenly)
      const avgH = sameRowBlocks.reduce((s, b) => s + b.bbox.h, 0) / sameRowBlocks.length;
      const heightsOk = sameRowBlocks.every(b => Math.abs(b.bbox.h - avgH) < avgH * 0.5);
      
      if (heightsOk) {
        // Merge into a single composite block that preserves multi-column info
        const allItems = [];
        for (const b of sameRowBlocks) {
          allItems.push(...b.items);
          processed.add(blocks.indexOf(b));
        }
        // Sort items by Y then X to maintain reading order within the grid
        allItems.sort((a, b) => {
          const ay = pageHeight - a.transform[5];
          const by = pageHeight - b.transform[5];
          if (Math.abs(ay - by) > 2) return ay - by;
          return a.transform[4] - b.transform[4];
        });
        
        const bbox = {
          x: Math.min(...sameRowBlocks.map(b => b.bbox.x)),
          y: Math.min(...sameRowBlocks.map(b => b.bbox.y)),
          w: Math.max(...sameRowBlocks.map(b => b.bbox.x + b.bbox.w)) - Math.min(...sameRowBlocks.map(b => b.bbox.x)),
          h: Math.max(...sameRowBlocks.map(b => b.bbox.y + b.bbox.h)) - Math.min(...sameRowBlocks.map(b => b.bbox.y))
        };
        
        multiColumnBlocks.push({
          items: allItems,
          bbox,
          isMultiColumn: true,
          columnCount: sameRowBlocks.length
        });
        continue;
      }
    }
    
    if (!processed.has(i)) {
      multiColumnBlocks.push(block);
      processed.add(i);
    }
  }
  
  // Replace blocks with multi-column merged version
  blocks.length = 0;
  blocks.push(...multiColumnBlocks);

  // Compute font metadata per block using real font objects from commonObjs
  for (const block of blocks) {
    const sizes = [];
    let italicCount = 0;
    let boldCount = 0;

    for (const item of block.items) {
      const fh = Math.hypot(item.transform[2], item.transform[3]);
      if (fh > 0) sizes.push(fh);

      const fontMeta = fontMap?.get(item.fontName);
      if (fontMeta) {
        if (fontMeta.italic) italicCount++;
        if (fontMeta.bold || fontMeta.black) boldCount++;
      }
    }

    block.avgFontSize = sizes.length
      ? sizes.reduce((a, b) => a + b, 0) / sizes.length
      : 12;
    block.isItalic = italicCount > block.items.length * 0.4;
    block.isBold = boldCount > block.items.length * 0.4;
    block.isBlack = block.items.some(it => fontMap?.get(it.fontName)?.black);

    // Store the font metadata for the dominant font in this block
    block.fontMeta = fontMap?.get(block.items[0]?.fontName) || null;

    // Compute dominant fill color for the block
    const colorFreq = {};
    for (const item of block.items) {
      const c = item._color || "#000000";
      colorFreq[c] = (colorFreq[c] || 0) + 1;
    }
    let dominantColor = "#000000";
    let maxColorFreq = 0;
    for (const [c, freq] of Object.entries(colorFreq)) {
      if (freq > maxColorFreq) {
        maxColorFreq = freq;
        dominantColor = c;
      }
    }
    block.color = dominantColor;

    // Build color spans — contiguous runs of items sharing the same color
    // Character indices map to the concatenated text produced by blockToText
    block.colorSpans = [];
    if (block.items.length > 0) {
      let spanColor = block.items[0]._color || "#000000";
      let spanCharStart = 0;
      let charCount = 0;

      for (let i = 0; i < block.items.length; i++) {
        const c = block.items[i]._color || "#000000";
        const itemLen = (block.items[i].str || "").length;
        if (c !== spanColor) {
          block.colorSpans.push({ charStart: spanCharStart, charEnd: charCount, color: spanColor });
          spanCharStart = charCount;
          spanColor = c;
        }
        charCount += itemLen;
        // Account for spaces inserted between items by blockToText
        if (i < block.items.length - 1) charCount++;
      }
      block.colorSpans.push({ charStart: spanCharStart, charEnd: charCount, color: spanColor });
    }

    // Build styled segments — contiguous runs sharing the same bold/italic style
    block.styledSegments = [];
    if (block.items.length > 0) {
      const fm0 = fontMap?.get(block.items[0]?.fontName);
      let segBold = !!(fm0?.bold || fm0?.black);
      let segItalic = !!fm0?.italic;
      let segCharStart = 0;
      let stCharCount = 0;

      for (let i = 0; i < block.items.length; i++) {
        const fm = fontMap?.get(block.items[i].fontName);
        const itemBold = !!(fm?.bold || fm?.black);
        const itemItalic = !!fm?.italic;
        const itemLen = (block.items[i].str || "").length;

        if (itemBold !== segBold || itemItalic !== segItalic) {
          block.styledSegments.push({ charStart: segCharStart, charEnd: stCharCount, bold: segBold, italic: segItalic });
          segCharStart = stCharCount;
          segBold = itemBold;
          segItalic = itemItalic;
        }
        stCharCount += itemLen;
        if (i < block.items.length - 1) stCharCount++;
      }
      block.styledSegments.push({ charStart: segCharStart, charEnd: stCharCount, bold: segBold, italic: segItalic });
    }

    // Only keep styledSegments if there are actual style transitions
    if (block.styledSegments.length <= 1) {
      block.styledSegments = null;
    }
  }

  return blocks;
}

/**
 * Extract graphic regions from the page operator list.
 * Captures images and horizontal divider lines (thin rectangles).
 */
function extractGraphicRegions(opList, OPS) {
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

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];

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
    } else if (fn === OPS.rectangle) {
      // Check for thin horizontal lines (dividers)
      const [x, y, w, h] = args;
      if (w > 100 && h > 0.5 && h < 5) {
        const corners = [
          transformPoint(x, y),
          transformPoint(x + w, y),
          transformPoint(x, y + h),
          transformPoint(x + w, y + h),
        ];
        const xs = corners.map(c => c[0]);
        const ys = corners.map(c => c[1]);
        regions.push({
          type: "divider",
          bbox: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
        });
      }
    } else if (fn === OPS.constructPath) {
      // Detect horizontal lines drawn via moveTo + lineTo
      const subOps = args[0];
      const coords = args[1];
      if (subOps?.length === 2 && subOps[0] === 13 && subOps[1] === 14) {
        const [x1, y1, x2, y2] = coords;
        if (Math.abs(x2 - x1) > 100 && Math.abs(y2 - y1) < 3) {
          const p1 = transformPoint(x1, y1);
          const p2 = transformPoint(x2, y2);
          const minX = Math.min(p1[0], p2[0]);
          const maxX = Math.max(p1[0], p2[0]);
          const minY = Math.min(p1[1], p2[1]);
          const maxY = Math.max(p1[1], p2[1]);
          regions.push({
            type: "divider",
            bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
          });
        }
      }
    }
  }

  return regions;
}

/**
 * Detect graphic regions by scanning the rendered canvas for non-text content.
 * Complements op-based detection by also finding vector graphics (charts, diagrams).
 */
function detectGraphicRegionsFromRender(offCanvas, textBlocks, renderScale) {
  const w = offCanvas.width;
  const h = offCanvas.height;
  const ctx = offCanvas.getContext("2d");

  const cellPx = 16;
  const cols = Math.ceil(w / cellPx);
  const rows = Math.ceil(h / cellPx);
  const occupied = new Uint8Array(cols * rows);

  // Mark cells covered by text blocks
  for (const block of textBlocks) {
    const margin = 4 * renderScale;
    const x0 = Math.floor(Math.max(0, block.bbox.x * renderScale - margin) / cellPx);
    const y0 = Math.floor(Math.max(0, block.bbox.y * renderScale - margin) / cellPx);
    const x1 = Math.ceil(Math.min(w, (block.bbox.x + block.bbox.w) * renderScale + margin) / cellPx);
    const y1 = Math.ceil(Math.min(h, (block.bbox.y + block.bbox.h) * renderScale + margin) / cellPx);
    for (let cy = y0; cy < y1 && cy < rows; cy++)
      for (let cx = x0; cx < x1 && cx < cols; cx++)
        occupied[cy * cols + cx] = 1;
  }

  // Scan non-text cells for visible content
  const imgData = ctx.getImageData(0, 0, w, h);
  const pixels = imgData.data;
  const hasContent = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (occupied[cy * cols + cx]) continue;
      const px0 = cx * cellPx, py0 = cy * cellPx;
      const px1 = Math.min(px0 + cellPx, w), py1 = Math.min(py0 + cellPx, h);
      let dark = 0, total = 0;
      for (let py = py0; py < py1; py += 2) {
        for (let px = px0; px < px1; px += 2) {
          const idx = (py * w + px) * 4;
          if (pixels[idx + 3] > 20) {
            const lum = 0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
            if (lum < 240) dark++;
          }
          total++;
        }
      }
      if (total > 0 && dark / total > 0.05) hasContent[cy * cols + cx] = 1;
    }
  }

  // Connected-component labeling to find graphic regions
  const visited = new Uint8Array(cols * rows);
  const regions = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (!hasContent[cy * cols + cx] || visited[cy * cols + cx]) continue;
      const queue = [[cx, cy]];
      visited[cy * cols + cx] = 1;
      let minX = cx, maxX = cx, minY = cy, maxY = cy, count = 0;
      while (queue.length > 0) {
        const [qx, qy] = queue.shift();
        minX = Math.min(minX, qx); maxX = Math.max(maxX, qx);
        minY = Math.min(minY, qy); maxY = Math.max(maxY, qy);
        count++;
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nx = qx + dx, ny = qy + dy;
          if (nx >= 0 && nx < cols && ny >= 0 && ny < rows &&
              hasContent[ny * cols + nx] && !visited[ny * cols + nx]) {
            visited[ny * cols + nx] = 1;
            queue.push([nx, ny]);
          }
        }
      }
      const rx = minX * cellPx / renderScale;
      const ry = minY * cellPx / renderScale;
      const rw = (maxX - minX + 1) * cellPx / renderScale;
      const rh = (maxY - minY + 1) * cellPx / renderScale;
      if (rw > 30 && rh > 30 && count > 4) {
        regions.push({ type: "graphic", bbox: { x: rx, y: ry, w: rw, h: rh }, screenCoords: true });
      }
    }
  }
  return regions;
}

/**
 * Find adaptive paragraph threshold by analyzing gap distribution.
 * Uses histogram approach to find natural breakpoint between line gaps and paragraph gaps.
 */
function findParagraphThreshold(gaps, fontSize) {
  if (gaps.length < 3) return 1.8;  // Fallback for small blocks

  // Filter out extreme outliers (>5x font size - likely headers, titles, etc.)
  const filtered = gaps.filter(g => g / fontSize < 5);
  if (filtered.length < 3) return 1.8;

  // Convert to font size ratios and sort
  const ratios = filtered.map(g => g / fontSize).sort((a, b) => a - b);

  // Find the largest gap between consecutive ratios (the "elbow")
  // Look for a significant jump (>0.3) between line spacing and paragraph spacing
  let maxGap = 0;
  let threshold = 1.8;  // Default fallback

  for (let i = 0; i < ratios.length - 1; i++) {
    const gap = ratios[i + 1] - ratios[i];
    // Look for significant gaps above typical line spacing (0.8x+)
    if (gap > maxGap && gap > 0.25 && ratios[i] > 0.8) {
      maxGap = gap;
      threshold = (ratios[i] + ratios[i + 1]) / 2;
    }
  }

  // If no clear cluster boundary found, use percentile-based approach
  // 75th percentile usually separates lines from paragraphs
  if (maxGap < 0.2) {
    const idx = Math.floor(ratios.length * 0.75);
    threshold = ratios[Math.min(idx, ratios.length - 1)];
  }

  // Clamp to reasonable range for paragraph detection
  // Line spacing is typically 1.0-1.3x, paragraphs 1.3-1.8x+
  return Math.max(1.25, Math.min(threshold, 2.2));
}

/**
 * Build text content for a block, preserving paragraph breaks.
 */
function blockToTextMultiColumn(block, pageHeight) {
  const rows = new Map();
  const fontHeight = block.avgFontSize || 12;
  const MARKER_PATTERN = /^[*+†‡#$§¶]$/; // Single char markers
  
  // Group items by row (finer granularity)
  for (const item of block.items) {
    if (!item.str) continue;
    const y = pageHeight - item.transform[5];
    const rowKey = Math.round(y / 2) * 2; // 2px granularity
    if (!rows.has(rowKey)) rows.set(rowKey, []);
    rows.get(rowKey).push(item);
  }
  
  const sortedRows = Array.from(rows.keys()).sort((a, b) => a - b);
  
  // Merge rows: if a row has only short items (markers), merge with next row
  const mergedRows = [];
  let pendingRow = null;
  
  for (const rowKey of sortedRows) {
    const rowItems = rows.get(rowKey).sort((a, b) => a.transform[4] - b.transform[4]);
    const rowText = rowItems.map(it => (it.str || "").trim()).join("");
    // A marker row has only single-char markers and possibly commas/spaces
    const allMarkers = rowItems.every(it => {
      const t = (it.str || "").trim();
      return t.length <= 1 || MARKER_PATTERN.test(t) || t === "," || t === " ";
    });
    
    if (allMarkers && rowItems.length >= 1 && rowText.length <= rowItems.length * 2) {
      // This is a marker row - merge with next row
      pendingRow = { key: rowKey, items: rowItems };
    } else {
      if (pendingRow) {
        // Merge pending marker row with this row
        // For each item in this row, find and attach the closest marker
        const mergedItems = [];
        const usedMarkers = new Set();
        
        for (const item of rowItems) {
          const itemCenterX = item.transform[4] + (item.width || 0) / 2;
          // Find closest marker that hasn't been used
          let closestMarker = null;
          let minDist = Infinity;
          let closestIdx = -1;
          
          for (let mi = 0; mi < pendingRow.items.length; mi++) {
            if (usedMarkers.has(mi)) continue;
            const marker = pendingRow.items[mi];
            const markerCenterX = marker.transform[4] + (marker.width || 0) / 2;
            const dist = Math.abs(markerCenterX - itemCenterX);
            if (dist < minDist) {
              minDist = dist;
              closestMarker = marker;
              closestIdx = mi;
            }
          }
          
          // Attach marker to item if close enough
          if (closestMarker && minDist < fontHeight * 3) { // Within 3x font height
            mergedItems.push({...item, str: item.str + closestMarker.str});
            usedMarkers.add(closestIdx);
          } else {
            mergedItems.push(item);
          }
        }
        
        // If there are unused markers, add them as separate items at the end
        for (let mi = 0; mi < pendingRow.items.length; mi++) {
          if (!usedMarkers.has(mi)) {
            mergedItems.push(pendingRow.items[mi]);
          }
        }
        
        mergedItems.sort((a, b) => a.transform[4] - b.transform[4]);
        mergedRows.push({ items: mergedItems, hasMarkers: true });
        pendingRow = null;
      } else {
        mergedRows.push({ items: rowItems, hasMarkers: false });
      }
    }
  }
  
  // Don't forget last pending row - add it as its own row
  // (these are orphaned markers that couldn't be attached)
  if (pendingRow) {
    // Only add if it has actual content, not just empty
    const hasContent = pendingRow.items.some(it => (it.str || "").trim().length > 0);
    if (hasContent) {
      mergedRows.push({ items: pendingRow.items, hasMarkers: true });
    }
  }
  
  // Build output lines
  const lines = [];
  for (const row of mergedRows) {
    let lineText = "";
    let lastX = null;
    let lastW = 0;
    let lastItemLen = 0;
    
    for (const item of row.items) {
      const currentX = item.transform[4];
      const currentItemLen = (item.str || "").trim().length;
      const isShortItem = currentItemLen <= 3;
      
      if (lastX !== null) {
        const hGap = currentX - (lastX + lastW);
        const prevWasLong = lastItemLen > 2;
        // Add column separator, but not before footnote markers
        if (hGap > fontHeight * 0.3 && (!prevWasLong || !isShortItem)) {
          lineText += "    ";
        }
      }
      
      lineText += item.str;
      lastX = currentX;
      lastW = item.width || fontHeight * 0.5;
      lastItemLen = currentItemLen;
    }
    lines.push(lineText.trim());
  }
  
  return lines.join("\n");
}

function blockToText(block, pageHeight) {
  // Special handling for multi-column blocks (like author grids)
  if (block.isMultiColumn && block.columnCount >= 2) {
    return blockToTextMultiColumn(block, pageHeight);
  }

  // First pass: collect all gaps and font sizes to compute adaptive threshold
  const gaps = [];
  let lastY = null;
  let lastFontSize = 12;

  for (const item of block.items) {
    if (!item.str) continue;
    const currentY = pageHeight - item.transform[5];
    const fontHeight = Math.hypot(item.transform[2], item.transform[3]);
    if (fontHeight > 0) lastFontSize = fontHeight;

    if (lastY !== null) {
      const vGap = Math.abs(currentY - lastY);
      gaps.push(vGap);
    }
    lastY = currentY;
  }

  // Compute adaptive paragraph threshold
  const paraThreshold = findParagraphThreshold(gaps, lastFontSize);
  const lineThreshold = lastFontSize * 0.3;  // Keep fixed line threshold

  // Second pass: build text with adaptive threshold
  let result = "";
  lastY = null;
  let lastX = null;
  let lastW = 0;
  let lastItemLen = 0; // Track length of previous item for marker detection
  const MARKER_PATTERN = /^[*+†‡#$§¶\s,]+$/; // Pattern for footnote markers and separators

  for (let i = 0; i < block.items.length; i++) {
    const item = block.items[i];
    if (!item.str) continue;
    const currentX = item.transform[4];
    const currentY = pageHeight - item.transform[5];
    const currentItemLen = (item.str || "").trim().length;
    const itemTextTrimmed = (item.str || "").trim();
    // Short items are typically footnote markers (*, †, ‡, #, etc.)
    // Allow up to 3 chars to handle combined markers like "* †"
    const isShortItem = currentItemLen <= 3;
    const isMarkerOnly = MARKER_PATTERN.test(itemTextTrimmed);
    
    // Check if next item is also a marker (to group markers together)
    const nextItem = block.items[i + 1];
    const nextIsMarker = nextItem && MARKER_PATTERN.test((nextItem.str || "").trim());

    if (lastY !== null) {
      const vGap = Math.abs(currentY - lastY);
      
      // Check if this looks like a superscript/subscript marker
      // Markers have: small vertical offset, short text, often special chars
      const isSuperscriptMarker = isShortItem && isMarkerOnly && vGap < lastFontSize * 0.6;

      // Use adaptive threshold for paragraph detection
      // But don't split paragraphs for superscript markers
      if (vGap > lastFontSize * paraThreshold && !isShortItem) {
        result += "\n\n";
      } else if (vGap > lineThreshold && !isSuperscriptMarker) {
        // Different line — insert space
        // But skip space if previous item was long and current is short (footnote marker)
        // This handles superscript markers like *, +, #, †, ‡
        const prevWasLong = lastItemLen > 2;
        if (!prevWasLong || !isShortItem) {
          if (!result.endsWith(" ") && !result.endsWith("\n")) {
            result += " ";
          }
        }
      } else if (lastX !== null) {
        // Same line or superscript position — check horizontal gap between items
        const hGap = currentX - (lastX + lastW);
        
        // For markers: only add space if there's a significant gap
        // This prevents "Mandelin *" and keeps "Mandelin*"
        const minGapForSpace = isMarkerOnly 
          ? lastFontSize * 0.5  // Larger threshold for markers
          : lastFontSize * 0.15;
          
        // Skip adding space before short marker items
        // These should attach directly to preceding text
        if (hGap > minGapForSpace && !isMarkerOnly) {
          if (!result.endsWith(" ") && !result.endsWith("\n")) {
            result += " ";
          }
        }
        // For markers after a space, don't add another space
        // But add the marker directly to the text
      }
    }
    lastY = currentY;
    lastX = currentX;
    lastW = item.width || 0;
    lastItemLen = currentItemLen;
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
    // Render-based regions are already in screen coords; op-based need conversion
    const bbox = gr.screenCoords
      ? { ...gr.bbox }
      : { x: gr.bbox.x, y: pageHeight - gr.bbox.y - gr.bbox.h, w: gr.bbox.w, h: gr.bbox.h };

    // Dividers pass through without text-overlap check
    if (gr.type === "divider") {
      regions.push({ type: "divider", bbox });
    } else {
      const overlapsText = textBboxes.some(tb => bboxOverlap(bbox, tb) > 0.3);
      if (!overlapsText) {
        regions.push({ type: "graphic", bbox });
      }
    }
  }

  // ── Column detection via histogram gap-finding ──
  const pageWidth = Math.max(...regions.map(r => r.bbox.x + r.bbox.w), 1);
  const narrowBlocks = regions.filter(r => r.bbox.w <= pageWidth * 0.6);
  let gapX = pageWidth / 2;
  let hasColumns = false;

  if (narrowBlocks.length >= 4) {
    // Build horizontal coverage histogram
    const binCount = 100;
    const binWidth = pageWidth / binCount;
    const coverage = new Uint8Array(binCount);
    for (const r of narrowBlocks) {
      const b0 = Math.max(0, Math.floor(r.bbox.x / binWidth));
      const b1 = Math.min(binCount, Math.ceil((r.bbox.x + r.bbox.w) / binWidth));
      for (let b = b0; b < b1; b++) coverage[b]++;
    }

    // Find widest empty gap in middle 60% of page
    const searchStart = Math.floor(binCount * 0.2);
    const searchEnd = Math.ceil(binCount * 0.8);
    let gapStart = -1, gapLen = 0, bestStart = -1, bestLen = 0;
    for (let b = searchStart; b < searchEnd; b++) {
      if (coverage[b] === 0) {
        if (gapStart < 0) gapStart = b;
        gapLen = b - gapStart + 1;
      } else {
        if (gapLen > bestLen) { bestLen = gapLen; bestStart = gapStart; }
        gapStart = -1; gapLen = 0;
      }
    }
    if (gapLen > bestLen) { bestLen = gapLen; bestStart = gapStart; }

    if (bestLen >= 2) {
      gapX = (bestStart + bestLen / 2) * binWidth;
      const leftCount = narrowBlocks.filter(r => r.bbox.x + r.bbox.w / 2 < gapX).length;
      const rightCount = narrowBlocks.filter(r => r.bbox.x + r.bbox.w / 2 >= gapX).length;
      hasColumns = leftCount > 2 && rightCount > 2;
    }
  }

  // ── Detect text alignment per block (including justified) ──
  for (const region of regions) {
    if (region.type !== "text") continue;
    const block = region.block;
    const leftMargin = block.bbox.x;
    const rightMargin = pageWidth - (block.bbox.x + block.bbox.w);
    const marginDiff = Math.abs(leftMargin - rightMargin);

    // Detect justified text: multiple lines with consistent right edges
    let isJustified = false;
    if (block.items.length >= 3) {
      const lines = [];
      let lineItems = [];
      let lastLineY = null;
      for (const item of block.items) {
        const y = pageHeight - item.transform[5];
        if (lastLineY !== null && Math.abs(y - lastLineY) > 2) {
          if (lineItems.length > 0) lines.push(lineItems);
          lineItems = [];
        }
        lineItems.push(item);
        lastLineY = y;
      }
      if (lineItems.length > 0) lines.push(lineItems);

      if (lines.length >= 3) {
        // Compute right edge of each line (except last — last line is usually ragged)
        const rightEdges = [];
        for (let li = 0; li < lines.length - 1; li++) {
          const lastItem = lines[li][lines[li].length - 1];
          const rightX = lastItem.transform[4] + (lastItem.width || 0);
          rightEdges.push(rightX);
        }
        if (rightEdges.length >= 2) {
          const maxRight = Math.max(...rightEdges);
          const consistent = rightEdges.filter(r => Math.abs(r - maxRight) < pageWidth * 0.02);
          isJustified = consistent.length > rightEdges.length * 0.7;
        }
      }
    }

    if (hasColumns && block.bbox.w <= pageWidth * 0.6) {
      block.align = isJustified ? "justify" : "left";
    } else if (isJustified) {
      block.align = "justify";
    } else if (leftMargin > pageWidth * 0.05 && marginDiff < pageWidth * 0.1) {
      block.align = "center";
    } else {
      block.align = "left";
    }
  }

  // ── Sort in reading order ──
  if (hasColumns) {
    const fullWidth = regions.filter(r => r.bbox.w > pageWidth * 0.6);
    const leftCol = regions.filter(r => r.bbox.w <= pageWidth * 0.6 && r.bbox.x + r.bbox.w / 2 < gapX);
    const rightCol = regions.filter(r => r.bbox.w <= pageWidth * 0.6 && r.bbox.x + r.bbox.w / 2 >= gapX);
    const byY = (a, b) => a.bbox.y - b.bbox.y;
    fullWidth.sort(byY);
    leftCol.sort(byY);
    rightCol.sort(byY);

    // Interleave: full-width blocks mark section boundaries
    regions.length = 0;
    let li = 0, ri = 0;
    for (const fw of fullWidth) {
      while (li < leftCol.length && leftCol[li].bbox.y < fw.bbox.y) regions.push(leftCol[li++]);
      while (ri < rightCol.length && rightCol[ri].bbox.y < fw.bbox.y) regions.push(rightCol[ri++]);
      regions.push(fw);
    }
    while (li < leftCol.length) regions.push(leftCol[li++]);
    while (ri < rightCol.length) regions.push(rightCol[ri++]);
  } else {
    regions.sort((a, b) => {
      if (Math.abs(a.bbox.y - b.bbox.y) > 10) return a.bbox.y - b.bbox.y;
      return a.bbox.x - b.bbox.x;
    });
  }

  // ── Compute inter-block vertical gaps from original PDF layout ──
  for (let i = 1; i < regions.length; i++) {
    const prev = regions[i - 1];
    const curr = regions[i];
    const prevBottom = prev.bbox.y + prev.bbox.h;
    const currTop = curr.bbox.y;
    curr.gapBefore = Math.max(0, currTop - prevBottom);
  }
  if (regions.length > 0) {
    regions[0].gapBefore = 0; // padding handles top margin
  }

  // Store absolute pixel gaps and compute body font size for scaling
  const bodyBlocks = regions.filter(r =>
    r.type === "text" && r.block?.fontScale && Math.abs(r.block.fontScale - 1) < 0.15);
  const avgBodyFontSize = bodyBlocks.length > 0
    ? bodyBlocks.reduce((s, r) => s + r.block.avgFontSize, 0) / bodyBlocks.length
    : 12;
  for (const region of regions) {
    region.gapAbsolute = region.gapBefore || 0;
    region._avgBodyFontSize = avgBodyFontSize;
    // Keep gapRatio as fallback for any code that reads it
    const avgBodyLH = avgBodyFontSize * 1.6;
    region.gapRatio = (region.gapBefore || 0) / avgBodyLH;
  }

  return regions;
}

// ─── Page analysis cache ──────────────────────────────────────────────────

async function analyzePage(page, OPS) {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // Get text content with styles
  const textContent = await page.getTextContent();

  // Get operator list once (reused for text/non-text classification + image extraction + font metadata)
  const opList = await page.getOperatorList();

  // Identify text operation indices for operationsFilter
  const textOpIndices = new Set();
  let inTextBlock = false;
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    if (fn === OPS.beginText) inTextBlock = true;
    if (inTextBlock) textOpIndices.add(i);
    if (fn === OPS.endText) inTextBlock = false;
  }

  // Extract graphic regions from operator list CTM tracking
  const opGraphicRegions = extractGraphicRegions(opList, OPS);

  // Render non-text only (images, paths, fills, backgrounds)
  const renderScale = 2;
  const offCanvas = document.createElement("canvas");
  offCanvas.width = Math.floor(pageWidth * renderScale);
  offCanvas.height = Math.floor(pageHeight * renderScale);
  const offCtx = offCanvas.getContext("2d");

  const renderViewport = page.getViewport({ scale: renderScale });
  await page.render({
    canvasContext: offCtx,
    viewport: renderViewport,
    operationsFilter: (index) => !textOpIndices.has(index),
  }).promise;

  // Get precise image coordinates via recordImages (supplements CTM detection).
  // This full render also loads fonts into commonObjs as a side effect.
  let imageCoordRegions = [];
  let fullRenderDone = false;
  try {
    const imgTrackCanvas = document.createElement("canvas");
    imgTrackCanvas.width = offCanvas.width;
    imgTrackCanvas.height = offCanvas.height;
    const imgRenderTask = page.render({
      canvasContext: imgTrackCanvas.getContext("2d"),
      viewport: renderViewport,
      recordImages: true,
    });
    await imgRenderTask.promise;
    fullRenderDone = true;
    const imageCoords = imgRenderTask.imageCoordinates;
    if (imageCoords && imageCoords.length > 0) {
      for (let j = 0; j < imageCoords.length; j += 6) {
        const x1 = imageCoords[j], y1 = imageCoords[j + 1];
        const x2 = imageCoords[j + 2], y2 = imageCoords[j + 3];
        const x3 = imageCoords[j + 4], y3 = imageCoords[j + 5];
        const xs = [x1, x2, x3];
        const ys = [y1, y2, y3];
        const minX = Math.min(...xs) / renderScale;
        const maxX = Math.max(...xs) / renderScale;
        const minY = Math.min(...ys) / renderScale;
        const maxY = Math.max(...ys) / renderScale;
        if (maxX - minX > 10 && maxY - minY > 10) {
          imageCoordRegions.push({
            type: "graphic",
            bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
            screenCoords: true,
          });
        }
      }
    }
  } catch (_) {
    // recordImages not supported — CTM fallback is used
  }

  // Ensure fonts are loaded for commonObjs access. If the recordImages render
  // above didn't run, do a minimal full render to trigger font loading.
  if (!fullRenderDone) {
    const fontCanvas = document.createElement("canvas");
    fontCanvas.width = 1;
    fontCanvas.height = 1;
    const fontViewport = page.getViewport({ scale: 0.1 });
    try {
      await page.render({ canvasContext: fontCanvas.getContext("2d"), viewport: fontViewport }).promise;
    } catch (_) {}
  }

  // Extract real font metadata from commonObjs (bold, italic, weight, loadedName)
  const fontMap = await extractFontMetadata(page, opList, OPS);

  // Extract text with colors from operator list
  const textRuns = extractTextWithColors(opList, OPS);

  // Now group text blocks with real font data and matched colors
  const textBlocks = groupTextBlocks(textContent.items, pageHeight, textContent.styles, fontMap, textRuns);

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

  // Detect graphics from rendered non-text canvas (catches vector graphics)
  const renderGraphicRegions = detectGraphicRegionsFromRender(offCanvas, textBlocks, renderScale);

  // Merge all sources, deduplicating by overlap
  const graphicRegions = [...opGraphicRegions];
  for (const rg of [...imageCoordRegions, ...renderGraphicRegions]) {
    const overlapsExisting = graphicRegions.some(og => {
      const ogBbox = og.screenCoords
        ? og.bbox
        : { x: og.bbox.x, y: pageHeight - og.bbox.y - og.bbox.h, w: og.bbox.w, h: og.bbox.h };
      return bboxOverlap(rg.bbox, ogBbox) > 0.3;
    });
    if (!overlapsExisting) graphicRegions.push(rg);
  }

  // Build region map (filters overlapping graphics, detects columns + alignment)
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
    fontMap,
    bodyFontSize,
  };
}

// ─── Reflow + composite engine ────────────────────────────────────────────

function reflowAndComposite(analysis, opts) {
  const { regionMap, bitmaps, pageWidth, pageHeight, fontMap } = analysis;
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

  // Pre-pass: merge runs of narrow text blocks into structured blocks
  // Author grids get fragmented by groupTextBlocks — merge consecutive narrow blocks
  // that together span a significant portion of the page width
  const mergedMap = [];
  let mi = 0;
  while (mi < regionMap.length) {
    const region = regionMap[mi];
    if (region.type !== "text" || region.block.bbox.w > pageWidth * 0.5) {
      mergedMap.push(region);
      mi++;
      continue;
    }

    // Collect consecutive narrow text blocks within a compact vertical range
    // Stop at large vertical gaps, section breaks, font changes, or page limits
    const run = [region];
    const startY = region.bbox.y;
    let mj = mi + 1;
    while (mj < regionMap.length) {
      const next = regionMap[mj];
      if (next.type !== "text") break;
      // Stop if run is already large enough (author grids < 20 blocks)
      if (run.length >= 20) break;
      // Large vertical gap = section break
      const gap = next.gapAbsolute || 0;
      const avgFS = next.block.avgFontSize || 12;
      if (gap > avgFS * 2) break;
      // Stop if font size changes significantly (heading vs body)
      const firstFS = run[0].block.avgFontSize || 12;
      const nextFS = next.block.avgFontSize || 12;
      if (Math.max(firstFS, nextFS) / Math.min(firstFS, nextFS) > 1.3) break;
      // Stop if a block is bold and previous blocks aren't (section heading)
      if (next.block.isBold && !run[run.length - 1].block.isBold && run.length >= 3) break;
      // Only include narrow blocks or wide blocks with high X-cluster count
      if (next.block.bbox.w > pageWidth * 0.5) {
        const nxPos = next.block.items.map(it => it.transform[4]).sort((a, b) => a - b);
        let nxC = 1;
        for (let k = 1; k < nxPos.length; k++) {
          if (nxPos[k] - nxPos[k - 1] > avgFS * 5) nxC++;
        }
        if (nxC < 3) break;
      }
      // Stop if past the first half of the page (structured blocks are at the top)
      if (next.bbox.y > pageHeight * 0.55) break;
      if (next.bbox.y + next.bbox.h - startY > pageHeight * 0.25) break;
      run.push(next);
      mj++;
    }

    if (run.length >= 3) {
      const combinedX = Math.min(...run.map(r => r.bbox.x));
      const combinedW = Math.max(...run.map(r => r.bbox.x + r.bbox.w)) - combinedX;
      const combinedBottom = Math.max(...run.map(r => r.bbox.y + r.bbox.h));
      const combinedH = combinedBottom - Math.min(...run.map(r => r.bbox.y));
      // Only merge if in top half of page, height is reasonable, and width spans enough
      if (combinedW > pageWidth * 0.4 && combinedH < pageHeight * 0.35 && combinedBottom < pageHeight * 0.6) {
        // Merge into a single block for structured positioning
        const allItems = [];
        for (const r of run) allItems.push(...r.block.items);
        const mergedBbox = {
          x: combinedX,
          y: Math.min(...run.map(r => r.bbox.y)),
          w: combinedW,
          h: Math.max(...run.map(r => r.bbox.y + r.bbox.h)) - Math.min(...run.map(r => r.bbox.y)),
        };
        const first = run[0].block;
        mergedMap.push({
          type: "text",
          block: {
            items: allItems,
            bbox: mergedBbox,
            avgFontSize: first.avgFontSize,
            fontScale: first.fontScale,
            fontMeta: first.fontMeta,
            color: first.color,
            _structured: true, // Merged narrow blocks = structured layout
          },
          bbox: mergedBbox,
          gapAbsolute: run[0].gapAbsolute,
          _avgBodyFontSize: run[0]._avgBodyFontSize,
        });
        mi = mj;
        continue;
      }
    }
    mergedMap.push(region);
    mi++;
  }

  const reflowedRegions = [];

  for (const region of mergedMap) {
    if (region.type === "text") {
      const block = region.block;
      const text = blockToText(block, pageHeight);
      if (!text) {
        reflowedRegions.push({ type: "text", lines: [], height: 0, region });
        continue;
      }

      // Structured blocks are identified by the merge pre-pass (_structured flag)
      const isStructuredBlock = !!block._structured;


      if (isStructuredBlock) {
        // Proportional positioning: preserve original relative layout scaled to fit
        const blockFontSize = Math.round(fontSize * (block.fontScale || 1));
        const scale = blockFontSize / (block.avgFontSize || 12);
        const scaledWidth = block.bbox.w * scale;
        const finalScale = scaledWidth > availableWidth ? availableWidth / block.bbox.w : scale;
        const offsetX = scaledWidth < availableWidth ? (availableWidth - scaledWidth) / 2 : 0;

        const positionedItems = [];
        for (const item of block.items) {
          if (!item.str) continue;
          const itemFM = fontMap?.get(item.fontName);
          const itemBold = !!(itemFM?.bold || itemFM?.black);
          const itemItalic = !!itemFM?.italic;
          let itemFamily;
          if (itemFM?.loadedName) {
            itemFamily = `"${itemFM.loadedName}", ${itemFM.fallbackName || "sans-serif"}`;
          } else if (itemFM?.css) {
            itemFamily = itemFM.css;
          } else {
            itemFamily = fontFamily;
          }
          const itemPdfFS = Math.hypot(item.transform[2], item.transform[3]);

          positionedItems.push({
            text: item.str,
            x: (item.transform[4] - block.bbox.x) * finalScale + offsetX,
            y: (pageHeight - item.transform[5] - block.bbox.y) * finalScale,
            fontSize: itemPdfFS * finalScale,
            bold: itemBold,
            italic: itemItalic,
            fontFamily: itemFamily,
            color: item._color || block.color || "#000000",
          });
        }

        const blockHeight = block.bbox.h * finalScale;
        reflowedRegions.push({
          type: "positioned",
          items: positionedItems,
          height: blockHeight,
          region,
        });
        continue;
      }

      // Per-block font properties using real font metadata from commonObjs
      const blockFontSize = Math.round(fontSize * (block.fontScale || 1));
      const blockLH = blockFontSize * lineHeight;
      const fm = block.fontMeta;
      const style = block.isItalic ? "italic" : "normal";
      const weight = block.isBlack ? 900 : block.isBold ? 700 : 400;

      // Use the actual embedded PDF font if available (PDF.js loaded it via @font-face)
      let blockFamily;
      if (fm?.loadedName) {
        blockFamily = `"${fm.loadedName}", ${fm.fallbackName || "sans-serif"}`;
      } else if (fm?.css) {
        blockFamily = fm.css;
      } else {
        blockFamily = fontFamily;
      }
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
        align: block.align || "left",
        color: block.color,
        colorSpans: block.colorSpans || [],
        styledSegments: block.styledSegments || null,
        region,
      });
    } else if (region.type === "divider") {
      // Horizontal divider line
      reflowedRegions.push({
        type: "divider",
        height: 4, // Small height for the divider line area
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

  // Total height — use absolute pixel gaps scaled by font ratio
  const baseLH = fontSize * lineHeight;
  let totalHeight = padding;
  for (const r of reflowedRegions) {
    totalHeight += r.height;
    const gapAbs = r.region?.gapAbsolute ?? 0;
    const bodyFS = r.region?._avgBodyFontSize || 12;
    const scaledGap = gapAbs * (fontSize / bodyFS);
    totalHeight += Math.max(4, Math.min(scaledGap, baseLH * 2.0));
  }
  totalHeight += padding;

  return { totalHeight, reflowedRegions, fullPageFallback: false };
}

// ─── Main API ─────────────────────────────────────────────────────────────

export function createReflowRenderer(container, options = {}) {
  const minFont = options.minFontSize ?? 8;
  const maxFont = options.maxFontSize ?? 48;
  const fontFamily = options.fontFamily ?? '"Literata", Georgia, serif';
  const lhRatio = options.lineHeight ?? 1.6;
  let padding = options.padding ?? 24;
  const bg = options.background ?? "#f4f1eb";
  const textColor = options.textColor ?? "#252320";
  const imageFit = options.imageFit ?? "proportional";
  const enablePinchZoom = options.enablePinchZoom ?? true;
  const enableMomentumScroll = options.enableMomentumScroll ?? true;
  const friction = options.friction ?? 0.95;
  const onZoom = options.onZoom;
  const onPageReady = options.onPageReady;
  const enableMorph = options.enableMorph ?? false;
  const morphRadius = options.morphRadius ?? 300;
  const edgeFontRatio = options.edgeFontRatio ?? 0.5;
  const maxWidth = options.maxWidth ?? Infinity;
  const autoDetectPadding = options.autoDetectPadding ?? true;
  const minPadding = options.minPadding ?? 20;

  let pdfjs = null;
  let pdfDoc = null;
  let currentPage = 0;
  const userSetFontSize = options.fontSize != null;
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
    // Auto-detect padding from PDF page margins
    if (autoDetectPadding && currentAnalysis.textBlocks.length > 0 && currentAnalysis.pageWidth > 0) {
      const minX = Math.min(...currentAnalysis.textBlocks.map(b => b.bbox.x));
      const maxX = Math.max(...currentAnalysis.textBlocks.map(b => b.bbox.x + b.bbox.w));
      const rightMargin = currentAnalysis.pageWidth - maxX;
      const pdfMargin = Math.min(minX, rightMargin);
      const marginRatio = pdfMargin / currentAnalysis.pageWidth;
      padding = Math.round(Math.max(minPadding, W * marginRatio));
    }
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
    const viewCenter = H / 2;

    for (const r of reflowedRegions) {
      if (r.type === "text" && r.lines) {
        const fs = r.fontSize || fontSize;
        const lh = r.lineHeight || baseLH;
        const rFamily = r.fontFamily || fontFamily;
        const style = r.fontStyle || "normal";
        const weight = r.fontWeight || 400;
        const centered = r.align === "center";
        const justified = r.align === "justify";
        const availW = W - padding * 2;

        const hasMultipleColors = r.colorSpans && r.colorSpans.length > 1 &&
          !r.colorSpans.every(s => s.color === r.colorSpans[0].color);
        const hasStyledSegments = r.styledSegments && r.styledSegments.length > 1;

        if (!enableMorph) {
          ctx.fillStyle = r.color || textColor;
          ctx.font = `${style} ${weight} ${fs * d}px ${rFamily}`;
        }

        let lineCharOffset = 0;
        for (let lineIdx = 0; lineIdx < r.lines.length; lineIdx++) {
          const line = r.lines[lineIdx];
          const screenY = cursorY - scrollY;
          if (screenY > -lh && screenY < H + lh) {
            // Justified: distribute extra space between words (not on last line)
            const isLastLine = lineIdx === r.lines.length - 1;
            const shouldJustify = justified && !isLastLine && line.text.includes(" ");

            if (enableMorph) {
              const dist = Math.abs(screenY - viewCenter);
              const t = Math.min(dist / morphRadius, 1);
              const ease = 1 - (1 - t) ** 3;
              const morphedFS = fs * (1 - ease * (1 - edgeFontRatio));
              const opacity = 1.0 + (0.2 - 1.0) * ease;
              // Blend the block's actual color toward gray at edges
              const blockColor = r.color || textColor;
              let morphColor;
              if (blockColor.startsWith("#") && blockColor.length === 7) {
                const br = parseInt(blockColor.slice(1, 3), 16);
                const bg_ = parseInt(blockColor.slice(3, 5), 16);
                const bb = parseInt(blockColor.slice(5, 7), 16);
                const dimR = Math.round(br + (160 - br) * ease);
                const dimG = Math.round(bg_ + (160 - bg_) * ease);
                const dimB = Math.round(bb + (160 - bb) * ease);
                morphColor = `rgb(${dimR},${dimG},${dimB})`;
              } else {
                const c = Math.round(37 - (37 - 160) * ease);
                morphColor = `rgb(${c},${c - 2},${c - 3})`;
              }
              ctx.save();
              ctx.globalAlpha = opacity;
              ctx.fillStyle = morphColor;
              ctx.font = `${style} ${weight} ${morphedFS * d}px ${rFamily}`;
              if (centered) {
                ctx.textAlign = "center";
                ctx.fillText(line.text, (W / 2) * d, screenY * d);
                ctx.textAlign = "left";
              } else if (shouldJustify) {
                drawJustifiedLine(ctx, line.text, padding * d, screenY * d, availW * d);
              } else {
                ctx.fillText(line.text, padding * d, screenY * d);
              }
              ctx.restore();
            } else if (hasStyledSegments && !hasMultipleColors) {
              // Per-segment bold/italic switching
              drawStyledLine(ctx, line.text, lineCharOffset, r.styledSegments,
                fs, rFamily, d, r.color || textColor,
                centered ? ((W * d - ctx.measureText(line.text).width) / 2) : padding * d,
                screenY * d);
              // Restore base font after styled line
              ctx.font = `${style} ${weight} ${fs * d}px ${rFamily}`;
            } else if (hasMultipleColors) {
              // Per-span coloring for inline colored text (links, emphasis)
              if (shouldJustify) {
                drawColoredJustifiedLine(ctx, line.text, lineCharOffset, r.colorSpans,
                  r.color || textColor, padding * d, screenY * d, availW * d);
              } else if (centered) {
                // Measure full line to center it, then draw colored from offset
                const lineW = ctx.measureText(line.text).width;
                const startX = (W * d - lineW) / 2;
                drawColoredLine(ctx, line.text, lineCharOffset, r.colorSpans,
                  r.color || textColor, startX, screenY * d);
              } else {
                drawColoredLine(ctx, line.text, lineCharOffset, r.colorSpans,
                  r.color || textColor, padding * d, screenY * d);
              }
            } else {
              if (centered) {
                ctx.textAlign = "center";
                ctx.fillText(line.text, (W / 2) * d, screenY * d);
                ctx.textAlign = "left";
              } else if (shouldJustify) {
                drawJustifiedLine(ctx, line.text, padding * d, screenY * d, availW * d);
              } else {
                ctx.fillText(line.text, padding * d, screenY * d);
              }
            }
          }
          lineCharOffset += line.text.length;
          cursorY += lh;
        }
      } else if (r.type === "positioned" && r.items) {
        // Proportionally positioned structured block (author grids, etc.)
        for (const item of r.items) {
          const screenY = cursorY + item.y - scrollY;
          if (screenY > -item.fontSize * 2 && screenY < H + item.fontSize * 2) {
            const iWeight = item.bold ? 700 : 400;
            const iStyle = item.italic ? "italic" : "normal";
            ctx.font = `${iStyle} ${iWeight} ${item.fontSize * d}px ${item.fontFamily}`;
            ctx.fillStyle = item.color || textColor;
            ctx.fillText(item.text, (padding + item.x) * d, screenY * d);
          }
        }
        cursorY += r.height;
      } else if (r.type === "divider") {
        // Draw horizontal divider line
        const screenY = cursorY - scrollY + 1; // Slight offset to center in area
        if (screenY > -10 && screenY < H + 10) {
          const lineWidth = Math.min(400, W - padding * 2); // Max 400px or fit with padding
          const startX = (W - lineWidth) / 2; // Center the line
          ctx.save();
          ctx.strokeStyle = textColor;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1 * d;
          ctx.beginPath();
          ctx.moveTo(startX * d, screenY * d);
          ctx.lineTo((startX + lineWidth) * d, screenY * d);
          ctx.stroke();
          ctx.restore();
        }
        cursorY += r.height;
      } else if (r.type === "graphic" && r.bitmap) {
        const screenY = cursorY - scrollY;
        if (screenY > -r.drawH && screenY < H + r.drawH) {
          const tmp = getTmpCanvas(r.bitmap);
          if (enableMorph) {
            const dist = Math.abs(screenY + r.drawH / 2 - viewCenter);
            const t = Math.min(dist / morphRadius, 1);
            const ease = 1 - (1 - t) ** 3;
            const imgScale = 1 - ease * (1 - edgeFontRatio);
            const opacity = 1.0 + (0.2 - 1.0) * ease;
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.drawImage(tmp, padding * d, screenY * d, r.drawW * imgScale * d, r.drawH * imgScale * d);
            ctx.restore();
          } else {
            ctx.drawImage(tmp, padding * d, screenY * d, r.drawW * d, r.drawH * d);
          }
        }
        cursorY += r.drawH;
      }
      const gapAbs = r.region?.gapAbsolute ?? 0;
      const bodyFS = r.region?._avgBodyFontSize || 12;
      const scaledGap = gapAbs * (fontSize / bodyFS);
      cursorY += Math.max(4, Math.min(scaledGap, baseLH * 2.0));
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
    W = Math.min(container.clientWidth, maxWidth);
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

      // Auto-match PDF body font size when user hasn't set an explicit fontSize
      if (!userSetFontSize && currentAnalysis.bodyFontSize) {
        fontSize = clamp(Math.round(currentAnalysis.bodyFontSize), minFont, maxFont);
      }

      scrollY = 0;
      scrollVelocity = 0;
      reflow();
      onZoom?.(fontSize);

      onPageReady?.({
        pageNum,
        textBlocks: currentAnalysis.textBlocks,
        graphicRegions: currentAnalysis.graphicRegions,
        pageWidth: currentAnalysis.pageWidth,
        pageHeight: currentAnalysis.pageHeight,
        bodyFontSize: currentAnalysis.bodyFontSize,
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
      onZoom?.(fontSize);
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

    setPadding(newPadding) {
      if (newPadding !== padding) {
        padding = newPadding;
        reflow();
      }
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
