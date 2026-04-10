import { SVG_STYLES } from "./svg-styles.js";

/**
 * Keyboard shortcut handler for WKWebView windows.
 * glimpseui's native window doesn't create a macOS Edit menu,
 * so Cmd+C/A/X key equivalents aren't routed to the WKWebView.
 * This JS-level handler bridges that gap.
 */
const KEYBOARD_SCRIPT = `<script>
document.addEventListener('keydown',function(e){
  if(!e.metaKey)return;
  switch(e.key){
    case'c':case'x':case'a':
      e.preventDefault();
      document.execCommand(e.key==='c'?'copy':e.key==='x'?'cut':'selectAll');
      break;
    case'w':
      e.preventDefault();
      if(window.glimpse&&typeof window.glimpse.close==='function')window.glimpse.close();
      else if(typeof window.close==='function')window.close();
      break;
  }
});
</script>`;

/** Shell HTML with a root container — used for streaming.
 *  Content is injected via win.send() JS eval, not setHTML(), to avoid full-page flashes. */
export function shellHTML(): string {
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{box-sizing:border-box;-webkit-user-select:text;user-select:text}
body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;cursor:text}
@keyframes _fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
${SVG_STYLES}
</style>
</head><body><div id="root"></div>
${KEYBOARD_SCRIPT}
<script>
  window._morphReady = false;
  window._pending = null;
  window._applyPending = function() {
    if (!window._morphReady || !window._pending) return;
    var html = window._pending;
    window._pending = null;
    window._setContent(html);
  };
  window._setContent = function(html) {
    if (!window._morphReady) { window._pending = html; return; }
    var root = document.getElementById('root');
    var target = document.createElement('div');
    target.id = 'root';
    target.innerHTML = html;
    morphdom(root, target, {
      onBeforeElUpdated: function(from, to) {
        if (from.isEqualNode(to)) return false;
        return true;
      },
      onNodeAdded: function(node) {
        if (node.nodeType === 1 && node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT') {
          node.style.animation = '_fadeIn 0.3s ease both';
        }
        return node;
      }
    });
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;window._applyPending();"></script>
</body></html>`;
}

/** Wrap HTML fragment into a full document for Glimpse (non-streaming fallback) */
export function wrapHTML(code: string, isSVG = false): string {
	if (isSVG) {
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{-webkit-user-select:text;user-select:text}body{cursor:text}${SVG_STYLES}</style></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}${KEYBOARD_SCRIPT}</body></html>`;
	}
	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box;-webkit-user-select:text;user-select:text}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;cursor:text}${SVG_STYLES}</style>
</head><body>${code}${KEYBOARD_SCRIPT}</body></html>`;
}

/** Escape a string for safe injection into a JS string literal */
export function escapeJS(s: string): string {
	return s
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "\\'")
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/<\/script>/gi, "<\\/script>");
}
