// shared/overlay.js
//
// Game-agnostic overlay renderer. Every game module (games/<name>/game.js)
// calls window.LockedInOverlay.show() with the cell elements it wants
// marked - this file knows nothing about Queens, Tango, Zip, etc., only how
// to draw and track floating markers over arbitrary page elements without
// ever touching them.
//
// Each marker is a translucent, color-tinted highlight covering most of its
// cell (not a small icon sitting on top of the cell's own icon) - a glance
// at the board should make "cells I still need to fill" obvious without
// having to compare two overlapping symbols. `html` (or a plain-text
// `glyph`) renders inside the highlight, colored via `color`. Once a game's
// `isFilled` check reports the user has placed the matching piece for a
// cell, the highlight fades to fully invisible rather than just dimming -
// "gone" reads as unambiguously done next to neighboring cells that are
// still lit up.

window.LockedInOverlay = (function () {
  let state = null;

  function isActive() {
    return state !== null;
  }

  function dismiss() {
    if (!state) return;
    cancelAnimationFrame(state.rafId);
    state.observer.disconnect();
    state.container.remove();
    state = null;
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3
      ? clean.split('').map((ch) => ch + ch).join('')
      : clean;
    const value = parseInt(full, 16);
    const r = (value >> 16) & 255;
    const g = (value >> 8) & 255;
    const b = value & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function applyMarkerStyle(markerEl, rect) {
    const inset = Math.min(rect.width, rect.height) * 0.1;
    const w = rect.width - inset * 2;
    const h = rect.height - inset * 2;
    markerEl.style.left = `${rect.left + inset}px`;
    markerEl.style.top = `${rect.top + inset}px`;
    markerEl.style.width = `${w}px`;
    markerEl.style.height = `${h}px`;
    markerEl.style.fontSize = `${Math.min(w, h) * 0.55}px`;
  }

  function positionDismissButton(btn, anchorRect) {
    btn.style.left = `${anchorRect.right - 8}px`;
    btn.style.top = `${anchorRect.top - 8}px`;
  }

  function updateSvgLine(svgLine) {
    const { polylineEl, cells } = svgLine;
    const firstRect = cells[0].getBoundingClientRect();
    const strokeWidth = Math.max(4, Math.min(firstRect.width, firstRect.height) * 0.28);
    polylineEl.setAttribute('stroke-width', strokeWidth);
    const points = cells
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `${r.left + r.width / 2},${r.top + r.height / 2}`;
      })
      .join(' ');
    polylineEl.setAttribute('points', points);
  }

  function startTrackingLoop() {
    function tick() {
      // SPA navigation guard: if the grid this overlay was drawn for has
      // been removed from the page (route change, re-render, etc.), clean
      // ourselves up instead of floating a stale overlay over new content.
      if (!document.body.contains(state.anchorEl)) {
        dismiss();
        return;
      }

      positionDismissButton(state.dismissBtn, state.anchorEl.getBoundingClientRect());
      for (const { cellEl, markerEl, isFilled } of state.markers) {
        applyMarkerStyle(markerEl, cellEl.getBoundingClientRect());
        if (isFilled) markerEl.classList.toggle('li-marker--confirmed', isFilled(cellEl));
      }
      if (state.svgLine) updateSvgLine(state.svgLine);

      state.rafId = requestAnimationFrame(tick);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  /**
   * @param {Object} opts
   * @param {Element} opts.anchorEl - the puzzle's root element; the overlay
   *   auto-dismisses if this leaves the DOM, and the dismiss button is
   *   anchored to its top-right corner.
   * @param {Array<{
   *   cellEl: Element,
   *   color?: string,            // hex color for the tint + icon/glyph (default gold)
   *   glyph?: string,             // plain-text content (e.g. '♛')
   *   html?: string,              // custom markup (e.g. an inline <svg>) - takes priority over glyph
   *   isFilled?: (cellEl: Element) => boolean,
   * }>} opts.markers - one highlight per cell that still needs to be filled in.
   * @param {{cells: Element[], color?: string}} [opts.linePath] - optional
   *   ordered list of cell elements to connect with a continuous SVG line
   *   (e.g. Zip path). When provided, a polyline is drawn through each cell's
   *   center. Can be used alongside markers (or with an empty markers array).
   */
  function show({ anchorEl, markers = [], linePath }) {
    const container = document.createElement('div');
    container.id = 'lockedin-solver-overlay';
    document.body.appendChild(container);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'li-dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.setAttribute('aria-label', 'Dismiss LockedIn solution overlay');
    dismissBtn.addEventListener('click', dismiss);
    container.appendChild(dismissBtn);

    let svgLine = null;
    if (linePath && linePath.cells && linePath.cells.length > 1) {
      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.setAttribute('class', 'li-path-svg');
      const polylineEl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      polylineEl.setAttribute('fill', 'none');
      polylineEl.setAttribute('stroke', linePath.color || '#f5c542');
      polylineEl.setAttribute('stroke-linecap', 'round');
      polylineEl.setAttribute('stroke-linejoin', 'round');
      polylineEl.setAttribute('opacity', '0.85');
      svgEl.appendChild(polylineEl);
      container.appendChild(svgEl);
      svgLine = { polylineEl, cells: linePath.cells };
    }

    const markerEls = markers.map(({ cellEl, color, glyph, html, isFilled }) => {
      const markerEl = document.createElement('div');
      markerEl.className = 'li-marker';
      const tint = color || '#f5c542';
      markerEl.style.color = tint;
      markerEl.style.background = hexToRgba(tint, 0.22);
      markerEl.style.borderColor = hexToRgba(tint, 0.7);
      if (html) markerEl.innerHTML = html; // always our own static, hardcoded markup - never page/user-derived content
      else markerEl.textContent = glyph || '';
      container.appendChild(markerEl);
      return { cellEl, markerEl, isFilled };
    });

    // Belt-and-suspenders alongside the rAF loop's own containment check:
    // react immediately (rather than waiting up to one frame) if the grid
    // is removed during a SPA route change.
    const observer = new MutationObserver(() => {
      if (!document.body.contains(anchorEl)) dismiss();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    state = { container, dismissBtn, markers: markerEls, anchorEl, observer, rafId: null, svgLine };
    startTrackingLoop();
  }

  return { isActive, show, dismiss };
})();
