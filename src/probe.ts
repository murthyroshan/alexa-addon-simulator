// The card audit: a small script added to each MCP App before it runs. Inside the card's sandbox it
// measures what is actually on screen (text sizes, contrast, tap targets, overflow) and posts the
// numbers to the simulator, which turns them into findings. The card itself is not changed.
import type { Check } from './checks';

export interface ProbeMetrics {
  viewport: { width: number; height: number };
  /** Characters of visible text at each font size (CSS px, rounded). */
  textBySize: Record<string, number>;
  /** Visible text whose contrast with its background is below 4.5:1 (3:1 for large text). */
  lowContrast: Array<{ text: string; ratio: number; size: number }>;
  /** Buttons and links smaller than 48 × 48 px. */
  smallTargets: Array<{ label: string; width: number; height: number }>;
  targets: number;
  /** Content taller or wider than the card's own viewport. */
  overflow: { x: number; y: number };
}

/** Echo Show cards are read from across a room: text under 18 px (in a 1280-wide layout) is hard to read there. */
export const MIN_TEXT_PX = 18;
export const MIN_TARGET_PX = 48;

/** The script, as text: injected at the start of the card's HTML. */
export const PROBE_SCRIPT = `<script>(function () {
  var timer = null;
  // Colours as [r, g, b, alpha]; see-through layers are blended over what is under them.
  function rgba(c) {
    var m = c && c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(function (x) { return parseFloat(x); });
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  function over(top, under) {
    var a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  }
  function lum(c) {
    var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  // The colour behind an element, or null when it can't be known (a gradient, an image, or a
  // see-through card drawn over whatever the host shows).
  function bgOf(el) {
    var layers = [];
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      var s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      var c = rgba(s.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    if (!layers.length || layers[layers.length - 1][3] < 1) return null;
    var out = layers.pop();
    while (layers.length) out = over(layers.pop(), out);
    return out;
  }
  function visible(el) {
    var r = el.getBoundingClientRect(); if (!r.width || !r.height) return false;
    var s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  }
  function measure() {
    var bySize = {}, low = [], small = [], targets = 0;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var n = walker.nextNode(); n; n = walker.nextNode()) {
      var t = n.nodeValue.trim(); if (!t) continue;
      var el = n.parentElement; if (!el || !visible(el)) continue;
      var tag = el.tagName; if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      var s = getComputedStyle(el), size = Math.round(parseFloat(s.fontSize));
      bySize[size] = (bySize[size] || 0) + t.length;
      var bgc = bgOf(el), fgc = rgba(s.color);
      if (bgc && fgc) {
        var fg = lum(over(fgc, bgc)), bg = lum(bgc);
        var ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        var large = size >= 24 || (size >= 18.5 && parseInt(s.fontWeight, 10) >= 700);
        if (ratio < (large ? 3 : 4.5) && low.length < 12) low.push({ text: t.slice(0, 40), ratio: Math.round(ratio * 10) / 10, size: size });
      }
    }
    var els = document.querySelectorAll('button, a[href], [role="button"], input, select, textarea, [onclick]');
    for (var i = 0; i < els.length; i++) {
      if (!visible(els[i])) continue;
      targets++;
      var r = els[i].getBoundingClientRect();
      if ((r.width < ${MIN_TARGET_PX} || r.height < ${MIN_TARGET_PX}) && small.length < 12) small.push({ label: (els[i].getAttribute('aria-label') || els[i].textContent || els[i].tagName).trim().slice(0, 30), width: Math.round(r.width), height: Math.round(r.height) });
    }
    var d = document.documentElement;
    parent.postMessage({ type: 'sim-probe', metrics: { viewport: { width: innerWidth, height: innerHeight }, textBySize: bySize, lowContrast: low, smallTargets: small, targets: targets, overflow: { x: Math.max(0, d.scrollWidth - innerWidth), y: Math.max(0, d.scrollHeight - innerHeight) } } }, '*');
  }
  function soon() { clearTimeout(timer); timer = setTimeout(measure, 700); }
  addEventListener('load', function () { soon(); new MutationObserver(soon).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); });
  addEventListener('resize', soon);
})();</script>`;

/** The card's HTML with the audit added first (it only reads the page). */
export function withProbe(html: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + PROBE_SCRIPT);
  return PROBE_SCRIPT + html;
}

/** Findings from a card's measurements. `fullscreen` cards must fit the screen without scrolling. */
export function probeChecks(card: string, m: ProbeMetrics, fullscreen: boolean): Check[] {
  const out: Check[] = [];
  const total = Object.values(m.textBySize).reduce((a, b) => a + b, 0);
  const small = Object.entries(m.textBySize)
    .filter(([size]) => Number(size) < MIN_TEXT_PX)
    .reduce((a, [, n]) => a + n, 0);
  const smallest = Object.keys(m.textBySize).map(Number).sort((a, b) => a - b)[0];
  if (total) {
    const share = small / total;
    out.push(
      share > 0.25
        ? { id: `probe-text:${card}`, level: 'warn', title: `${Math.round(share * 100)}% of the text on ${card} is under ${MIN_TEXT_PX} px`, detail: `The smallest is ${smallest} px. An Echo Show is read from across the kitchen: keep body text at ${MIN_TEXT_PX} px or more (in a 1280-wide layout), and small text for labels only.` }
        : { id: `probe-text:${card}`, level: 'pass', title: `Text on ${card} is readable from a distance`, detail: `${Math.round((1 - share) * 100)}% of it at ${MIN_TEXT_PX} px or more; smallest ${smallest} px.` },
    );
  }
  if (m.lowContrast.length)
    out.push({
      id: `probe-contrast:${card}`,
      level: 'warn',
      title: `Low contrast text on ${card}`,
      detail: `${m.lowContrast
        .slice(0, 3)
        .map((l) => `“${l.text}” ${l.ratio}:1`)
        .join(', ')}. WCAG asks for 4.5:1 (3:1 for large text).`,
    });
  else if (total) out.push({ id: `probe-contrast:${card}`, level: 'pass', title: `Text on ${card} has enough contrast` });
  if (m.smallTargets.length)
    out.push({
      id: `probe-targets:${card}`,
      level: 'warn',
      title: `${m.smallTargets.length} of ${m.targets} touch targets on ${card} are under ${MIN_TARGET_PX} px`,
      detail: `${m.smallTargets
        .slice(0, 3)
        .map((t) => `${t.label || 'unnamed'} (${t.width}×${t.height})`)
        .join(', ')}. Fingers on a kitchen screen need ${MIN_TARGET_PX} × ${MIN_TARGET_PX} px or more.`,
    });
  else if (m.targets) out.push({ id: `probe-targets:${card}`, level: 'pass', title: `Every touch target on ${card} is big enough` });
  if (fullscreen && (m.overflow.y > 4 || m.overflow.x > 4))
    out.push({ id: `probe-fit:${card}`, level: 'warn', title: `${card} doesn't fit the screen in full screen`, detail: `It is ${m.overflow.y} px too tall and ${m.overflow.x} px too wide for ${m.viewport.width} × ${m.viewport.height}. Nobody scrolls a kitchen screen with wet hands.` });
  else if (m.overflow.x > 4) out.push({ id: `probe-fit:${card}`, level: 'warn', title: `${card} is ${m.overflow.x} px too wide`, detail: 'It scrolls sideways. Let it wrap at the width the host gives it.' });
  return out;
}
