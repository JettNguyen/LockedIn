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

  // --- Region outline helpers (used by Patches and any future region-coloring games) ---

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function edgeCoordsOf(rect, side) {
    switch (side) {
      case 'top':    return { x1: rect.left,  y1: rect.top,    x2: rect.right, y2: rect.top    };
      case 'bottom': return { x1: rect.left,  y1: rect.bottom, x2: rect.right, y2: rect.bottom };
      case 'left':   return { x1: rect.left,  y1: rect.top,    x2: rect.left,  y2: rect.bottom };
      case 'right':  return { x1: rect.right, y1: rect.top,    x2: rect.right, y2: rect.bottom };
    }
  }

  // Build SVG elements for every region up front. Each cell in a region gets:
  //   • a <rect> for the translucent fill (hidden when the user fills that cell)
  //   • one <line> per boundary edge (sides facing a different region or the grid
  //     border) — internal edges between cells of the same region are never drawn,
  //     giving the region a single connected outline rather than a grid of boxes.
  // The outline lines stay visible until ALL cells in the region are filled; at
  // that point the entire group fades out at once.
  function buildRegionsSvg(container, regions) {
    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('class', 'li-path-svg');
    container.appendChild(svgEl);

    const regionItems = regions.map(({ color, cells, isCellFilled }) => {
      const fillColor = hexToRgba(color, 0.35);

      const cellItems = cells.map(({ cellEl, edges }) => {
        const fillRect = document.createElementNS(SVG_NS, 'rect');
        fillRect.setAttribute('fill', fillColor);
        fillRect.setAttribute('stroke', 'none');
        svgEl.appendChild(fillRect);

        const edgeLines = edges.map((side) => {
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('stroke', color);
          // butt linecap: lines end exactly at cell corners with no overshoot,
          // so adjacent boundary lines meet cleanly at shared corners.
          // square linecap extends each segment by stroke-width/2 past its
          // endpoints, closing corners cleanly and bridging any sub-pixel
          // gaps between adjacent cells' bounding rects.
          line.setAttribute('stroke-linecap', 'square');
          svgEl.appendChild(line);
          return { side, line };
        });

        return { cellEl, fillRect, edgeLines };
      });

      return { cellItems, isCellFilled };
    });

    return { svgEl, regionItems };
  }

  function updateRegionsSvg(regionsState) {
    for (const { cellItems, isCellFilled } of regionsState.regionItems) {
      // Check if every cell in this region has been placed by the user.
      let allFilled = true;
      for (const { cellEl } of cellItems) {
        if (!isCellFilled(cellEl)) { allFilled = false; break; }
      }

      // Derive stroke width from the first cell so it scales with grid size.
      let strokeWidth = 2.5;
      if (cellItems.length > 0) {
        const r0 = cellItems[0].cellEl.getBoundingClientRect();
        strokeWidth = Math.max(1.5, Math.min(r0.width, r0.height) * 0.06);
      }

      for (const { cellEl, fillRect, edgeLines } of cellItems) {
        const filled = isCellFilled(cellEl);
        const rect = cellEl.getBoundingClientRect();

        // Per-cell fill fades immediately when that cell is placed.
        fillRect.setAttribute('x', rect.left);
        fillRect.setAttribute('y', rect.top);
        fillRect.setAttribute('width', rect.width);
        fillRect.setAttribute('height', rect.height);
        fillRect.setAttribute('opacity', filled ? 0 : 1);

        // Outline lines wait until the entire region is solved, then fade.
        for (const { side, line } of edgeLines) {
          const c = edgeCoordsOf(rect, side);
          line.setAttribute('x1', c.x1);
          line.setAttribute('y1', c.y1);
          line.setAttribute('x2', c.x2);
          line.setAttribute('y2', c.y2);
          line.setAttribute('stroke-width', strokeWidth);
          line.setAttribute('opacity', allFilled ? 0 : 1);
        }
      }
    }
  }

  // --- SVG path line helpers (used by Zip) ---

  function updateSvgLine(svgLine) {
    const { polylineEl, cells, isDrawn } = svgLine;

    // If isDrawn is provided, find the longest correctly-drawn prefix from the
    // front and only render the remaining suffix — the part the user still needs
    // to draw. If every cell is drawn, the line vanishes entirely.
    let displayCells = cells;
    if (isDrawn) {
      let drawnCount = 0;
      for (const cell of cells) {
        if (isDrawn(cell)) drawnCount++;
        else break;
      }
      displayCells = cells.slice(drawnCount);
    }

    if (displayCells.length < 2) {
      polylineEl.setAttribute('points', '');
      return;
    }

    const firstRect = displayCells[0].getBoundingClientRect();
    const strokeWidth = Math.max(4, Math.min(firstRect.width, firstRect.height) * 0.28);
    polylineEl.setAttribute('stroke-width', strokeWidth);
    const points = displayCells
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
      for (const sl of state.svgLines) updateSvgLine(sl);
      if (state.regionsState) updateRegionsSvg(state.regionsState);

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
   * @param {{cells: Element[], color?: string, isDrawn?: Function}} [opts.linePath] - optional
   *   single ordered path (e.g. Zip). Shorthand for linePaths with one entry.
   * @param {Array<{cells: Element[], color?: string, isDrawn?: Function}>} [opts.linePaths] - optional
   *   multiple ordered paths drawn as separate colored polylines (e.g. Wend).
   *   If both linePath and linePaths are provided, linePaths takes precedence.
   * @param {Array<{
   *   color: string,
   *   cells: Array<{ cellEl: Element, edges: Array<'top'|'bottom'|'left'|'right'> }>,
   *   isCellFilled: (cellEl: Element) => boolean,
   * }>} [opts.regions] - optional per-region data for drawing connected region
   *   outlines (e.g. Patches). Each region renders as a translucent fill on all
   *   its cells plus a stroke only on the outer boundary edges. Fill fades per-
   *   cell as the user places pieces; the outline fades when the whole region is
   *   complete.
   */
  function show({ anchorEl, markers = [], linePath, linePaths, regions }) {
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

    let regionsState = null;
    if (regions && regions.length > 0) {
      regionsState = buildRegionsSvg(container, regions);
    }

    // Normalize linePath (singular, for backward compat) and linePaths (array) into
    // one list, then build a polyline SVG element for each entry.
    const allLinePaths = linePaths || (linePath ? [linePath] : []);
    const svgLines = allLinePaths
      .filter((lp) => lp && lp.cells && lp.cells.length > 1)
      .map((lp) => {
        const svgEl = document.createElementNS(SVG_NS, 'svg');
        svgEl.setAttribute('class', 'li-path-svg');
        const polylineEl = document.createElementNS(SVG_NS, 'polyline');
        polylineEl.setAttribute('fill', 'none');
        polylineEl.setAttribute('stroke', lp.color || '#f5c542');
        polylineEl.setAttribute('stroke-linecap', 'round');
        polylineEl.setAttribute('stroke-linejoin', 'round');
        polylineEl.setAttribute('opacity', '0.85');
        svgEl.appendChild(polylineEl);
        container.appendChild(svgEl);
        return { polylineEl, cells: lp.cells, isDrawn: lp.isDrawn || null };
      });

    const markerEls = markers.map(({ cellEl, color, glyph, html, isFilled }) => {
      const markerEl = document.createElement('div');
      markerEl.className = 'li-marker';
      const tint = color || '#f5c542';
      markerEl.style.color = tint;
      markerEl.style.background = hexToRgba(tint, 0.30);
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

    state = { container, dismissBtn, markers: markerEls, anchorEl, observer, rafId: null, svgLines, regionsState };
    startTrackingLoop();
  }

  return { isActive, show, dismiss };
})();
