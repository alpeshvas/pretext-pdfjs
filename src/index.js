/**
 * pretext-pdf
 *
 * Drop-in replacement for pdfjs-dist that swaps the TextLayer with a
 * Pretext-powered implementation. All other exports pass through from pdfjs-dist.
 *
 * Usage:
 *   // Instead of:  import { getDocument, TextLayer } from "pdfjs-dist";
 *   // Use:         import { getDocument, TextLayer } from "pretext-pdf";
 */

export {
  AbortException,
  AnnotationEditorLayer,
  AnnotationEditorParamsType,
  AnnotationEditorType,
  AnnotationEditorUIManager,
  AnnotationLayer,
  AnnotationMode,
  ColorPicker,
  DOMSVGFactory,
  DrawLayer,
  FeatureTest,
  GlobalWorkerOptions,
  ImageKind,
  InvalidPDFException,
  MissingPDFException,
  OPS,
  OutputScale,
  PDFDataRangeTransport,
  PDFDateString,
  PDFWorker,
  PasswordResponses,
  PermissionFlag,
  PixelsPerInch,
  RenderingCancelledException,
  TouchManager,
  UnexpectedResponseException,
  Util,
  VerbosityLevel,
  XfaLayer,
  build,
  createValidAbsoluteUrl,
  fetchData,
  getDocument,
  getFilenameFromUrl,
  getPdfFilenameFromUrl,
  getXfaPageViewport,
  isDataScheme,
  isPdfFile,
  noContextMenu,
  normalizeUnicode,
  setLayerDimensions,
  shadow,
  stopEvent,
  version,
} from "pdfjs-dist";

// Override TextLayer with Pretext-powered version
export { PretextTextLayer as TextLayer } from "./pretext-text-layer.js";

// Additional Pretext-specific exports
export {
  PretextTextLayer,
  PretextMeasurementCache,
  pretextCache,
} from "./pretext-text-layer.js";
