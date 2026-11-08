// Buy widget: an embeddable card (or grid) of items for any website, served by your own server.
export { renderWidget, renderCards, renderMissing } from "./widget.js";
export type { WidgetItem, WidgetStore, WidgetLabels, RenderOptions } from "./widget.js";
export { widgetHeaders, loaderHeaders, frameScriptHeaders, isWidgetPath } from "./headers.js";
export type { WidgetHeaderOptions } from "./headers.js";
export { LOADER_JS, FRAME_JS, frameJs, snippets } from "./loader.js";
export type { PathTemplates, LoaderOptions } from "./loader.js";
export { WIDGET_CSS } from "./widget-css.js";
export { escapeHtml, safeUrl, cssUrl } from "./escape.js";
