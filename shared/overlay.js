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
  // Set to true when the overlay is dismissed because the anchor element left the
  // DOM (SPA navigation / React re-render), NOT when the user clicks ✕. content.js
  // reads this via takeAutoDismissed() to know it should re-run the solver.
  let autoDismissed = false;

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

  // Called internally when the anchor leaves the DOM (not a user action).
  function dismissDueToNavigation() {
    autoDismissed = true;
    dismiss();
  }

  // One-shot: returns true if the overlay was auto-dismissed since the last call,
  // then resets the flag. Used by content.js to decide whether to re-solve.
  function takeAutoDismissed() {
    const val = autoDismissed;
    autoDismissed = false;
    return val;
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

  // Ids have to be unique across every overlay this page ever draws, so the
  // counter deliberately lives outside show().
  let hatchSeq = 0;

  function edgeCoordsOf(rect, side) {
    switch (side) {
      case 'top':    return { x1: rect.left,  y1: rect.top,    x2: rect.right, y2: rect.top    };
      case 'bottom': return { x1: rect.left,  y1: rect.bottom, x2: rect.right, y2: rect.bottom };
      case 'left':   return { x1: rect.left,  y1: rect.top,    x2: rect.left,  y2: rect.bottom };
      case 'right':  return { x1: rect.right, y1: rect.top,    x2: rect.right, y2: rect.bottom };
    }
  }

  // Diagonal stripes in the region's own color, used instead of a flat wash.
  // A flat tint is the same hue the page itself paints a placed cell with, so a
  // board where nothing has been placed yet still reads as finished and you
  // can't tell your own work from the suggestion. Stripes can only mean "the
  // overlay is proposing this"; solid can only mean "you placed this".
  //
  // Neighbouring regions alternate stripe direction so two similar colors
  // sitting side by side still separate visually.
  function buildHatchFill(defsEl, color, index) {
    const id = `lockedin-hatch-${++hatchSeq}`;
    const size = 8;

    const pattern = document.createElementNS(SVG_NS, 'pattern');
    pattern.setAttribute('id', id);
    pattern.setAttribute('width', size);
    pattern.setAttribute('height', size);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('patternTransform', `rotate(${index % 2 === 0 ? 45 : -45})`);

    const background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', size);
    background.setAttribute('height', size);
    background.setAttribute('fill', hexToRgba(color, 0.12));
    pattern.appendChild(background);

    const stripe = document.createElementNS(SVG_NS, 'rect');
    stripe.setAttribute('width', size / 2);
    stripe.setAttribute('height', size);
    stripe.setAttribute('fill', hexToRgba(color, 0.5));
    pattern.appendChild(stripe);

    defsEl.appendChild(pattern);
    return `url(#${id})`;
  }

  // Build SVG elements for every region up front. Each cell in a region gets:
  //   • a <rect> of hatching (hidden once the user fills that cell) — except
  //     clue cells, which the page already colors in and the user never places,
  //     so hatching them would just be noise sitting on top of a finished cell
  //   • one <line> per boundary edge (sides facing a different region or the grid
  //     border) — internal edges between cells of the same region are never drawn,
  //     giving the region a single connected outline rather than a grid of boxes.
  // The outline stays up until every *placeable* cell in the region is filled,
  // then the whole group fades at once.
  function buildRegionsSvg(container, regions) {
    const svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('class', 'li-path-svg');
    const defsEl = document.createElementNS(SVG_NS, 'defs');
    svgEl.appendChild(defsEl);
    container.appendChild(svgEl);

    const regionItems = regions.map(({ color, cells, isCellFilled }, regionIdx) => {
      const hatchFill = buildHatchFill(defsEl, color, regionIdx);

      const cellItems = cells.map(({ cellEl, edges, isClue }) => {
        let fillRect = null;
        if (!isClue) {
          fillRect = document.createElementNS(SVG_NS, 'rect');
          fillRect.setAttribute('fill', hatchFill);
          fillRect.setAttribute('stroke', 'none');
          svgEl.appendChild(fillRect);
        }

        const edgeLines = edges.map((side) => {
          const line = document.createElementNS(SVG_NS, 'line');
          line.setAttribute('stroke', color);
          // square linecap extends each segment by stroke-width/2 past its
          // endpoints, closing corners cleanly and bridging any sub-pixel
          // gaps between adjacent cells' bounding rects.
          line.setAttribute('stroke-linecap', 'square');
          svgEl.appendChild(line);
          return { side, line };
        });

        return { cellEl, fillRect, edgeLines, isClue: !!isClue };
      });

      return { cellItems, isCellFilled };
    });

    return { svgEl, regionItems };
  }

  function updateRegionsSvg(regionsState) {
    for (const { cellItems, isCellFilled } of regionsState.regionItems) {
      // Has the user placed every cell they actually have to place? Clue cells
      // are the page's own givens, so counting them here would make a finished
      // region look unfinished forever.
      let allFilled = true;
      for (const { cellEl, isClue } of cellItems) {
        if (isClue) continue;
        if (!isCellFilled(cellEl)) { allFilled = false; break; }
      }

      // Derive stroke width from the first cell so it scales with grid size.
      let strokeWidth = 2.5;
      if (cellItems.length > 0) {
        const r0 = cellItems[0].cellEl.getBoundingClientRect();
        strokeWidth = Math.max(1.5, Math.min(r0.width, r0.height) * 0.07);
      }

      for (const { cellEl, fillRect, edgeLines } of cellItems) {
        const rect = cellEl.getBoundingClientRect();

        // Per-cell hatching clears the moment that cell is placed, so what's
        // left striped is exactly what's left to do.
        if (fillRect) {
          fillRect.setAttribute('x', rect.left);
          fillRect.setAttribute('y', rect.top);
          fillRect.setAttribute('width', rect.width);
          fillRect.setAttribute('height', rect.height);
          fillRect.setAttribute('opacity', isCellFilled(cellEl) ? 0 : 1);
        }

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

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function updateSvgLine(svgLine) {
    const { polylineEl, cells, isDrawn, widthRatio, startRing, endArrow } = svgLine;

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
      if (startRing) startRing.setAttribute('r', 0);
      if (endArrow) endArrow.setAttribute('points', '');
      return;
    }

    const firstRect = displayCells[0].getBoundingClientRect();
    const cellSize = Math.min(firstRect.width, firstRect.height);
    polylineEl.setAttribute('stroke-width', Math.max(3, cellSize * widthRatio));

    const points = displayCells.map(centerOf);

    // A ring around the first cell rather than a blob on top of it: the point is
    // to say "start here" without hiding what's printed in the cell — Wend's
    // letter, Zip's waypoint number. The line is pulled back out of that cell
    // for the same reason, so the ring frames the marking instead of crossing it.
    const drawnPoints = points.map((p) => ({ x: p.x, y: p.y }));
    if (startRing) {
      const first = points[0];
      const second = points[1];
      const dx = second.x - first.x;
      const dy = second.y - first.y;
      const len = Math.hypot(dx, dy) || 1;
      const inset = cellSize * 0.34;
      drawnPoints[0] = { x: first.x + (dx / len) * inset, y: first.y + (dy / len) * inset };

      startRing.setAttribute('cx', first.x);
      startRing.setAttribute('cy', first.y);
      startRing.setAttribute('r', Math.max(6, cellSize * 0.36));
      startRing.setAttribute('stroke-width', Math.max(2, cellSize * 0.11));
    }

    polylineEl.setAttribute('points', drawnPoints.map((p) => `${p.x},${p.y}`).join(' '));

    // Arrowhead at the far end, pointing along the last segment, so the path
    // reads in a direction instead of being an ambiguous squiggle.
    if (endArrow) {
      const last = points[points.length - 1];
      const prev = points[points.length - 2];
      const dx = last.x - prev.x;
      const dy = last.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const size = Math.max(6, cellSize * 0.3);
      // Stop short of the final cell's centre so the arrow points *at* the last
      // letter rather than sitting on top of it. The polyline still runs all the
      // way in, so it's clear the cell belongs to the path.
      const inset = cellSize * 0.26;
      const tip = { x: last.x - ux * inset, y: last.y - uy * inset };
      const baseX = tip.x - ux * size;
      const baseY = tip.y - uy * size;
      const halfWidth = size * 0.55;
      endArrow.setAttribute(
        'points',
        `${tip.x},${tip.y} ` +
        `${baseX - uy * halfWidth},${baseY + ux * halfWidth} ` +
        `${baseX + uy * halfWidth},${baseY - ux * halfWidth}`
      );
    }
  }

  function startTrackingLoop() {
    function tick() {
      // SPA navigation guard: if the grid this overlay was drawn for has
      // been removed from the page (route change, re-render, etc.), clean
      // ourselves up instead of floating a stale overlay over new content.
      if (!document.body.contains(state.anchorEl)) {
        dismissDueToNavigation();
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
   * @param {Array<{
   *   cells: Element[],
   *   color?: string,
   *   isDrawn?: Function,
   *   widthRatio?: number,   // stroke width as a fraction of a cell (default 0.28).
   *                          // Drop it when the cell's own content has to stay
   *                          // readable through the line, as in Wend's letters.
   *   opacity?: number,      // default 0.85
   *   showEnds?: boolean,    // ring the first cell, arrowhead on the last, so a
   *                          // path reads with a start and a direction
   * }>} [opts.linePaths] - optional multiple ordered paths drawn as separate
   *   colored polylines (e.g. Wend).
   *   If both linePath and linePaths are provided, linePaths takes precedence.
   * @param {Array<{
   *   color: string,
   *   cells: Array<{
   *     cellEl: Element,
   *     edges: Array<'top'|'bottom'|'left'|'right'>,
   *     isClue?: boolean,        // a given the page already fills in for the user
   *   }>,
   *   isCellFilled: (cellEl: Element) => boolean,
   * }>} [opts.regions] - optional per-region data for drawing connected region
   *   outlines (e.g. Patches). Each region renders as diagonal hatching on its
   *   cells plus a stroke only on the outer boundary edges. Hatching clears
   *   per-cell as the user places pieces; the outline fades once every non-clue
   *   cell is placed. Clue cells are never hatched and never gate completion.
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
        const color = lp.color || '#f5c542';
        const svgEl = document.createElementNS(SVG_NS, 'svg');
        svgEl.setAttribute('class', 'li-path-svg');
        const polylineEl = document.createElementNS(SVG_NS, 'polyline');
        polylineEl.setAttribute('fill', 'none');
        polylineEl.setAttribute('stroke', color);
        polylineEl.setAttribute('stroke-linecap', 'round');
        polylineEl.setAttribute('stroke-linejoin', 'round');
        polylineEl.setAttribute('opacity', lp.opacity == null ? '0.85' : String(lp.opacity));
        svgEl.appendChild(polylineEl);

        // Appended after the polyline so they sit on top of it.
        let startRing = null;
        let endArrow = null;
        if (lp.showEnds) {
          startRing = document.createElementNS(SVG_NS, 'circle');
          startRing.setAttribute('fill', 'none');
          startRing.setAttribute('stroke', lp.startColor || color);
          // Pulses, so "where do I start?" is answered by a glance rather than
          // by tracing the line back to its end.
          startRing.setAttribute('class', 'li-path-start');
          svgEl.appendChild(startRing);

          endArrow = document.createElementNS(SVG_NS, 'polygon');
          endArrow.setAttribute('fill', lp.endColor || color);
          svgEl.appendChild(endArrow);
        }

        container.appendChild(svgEl);
        return {
          polylineEl,
          cells: lp.cells,
          isDrawn: lp.isDrawn || null,
          widthRatio: lp.widthRatio == null ? 0.28 : lp.widthRatio,
          startRing,
          endArrow,
        };
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
      if (!document.body.contains(anchorEl)) dismissDueToNavigation();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    state = { container, dismissBtn, markers: markerEls, anchorEl, observer, rafId: null, svgLines, regionsState };
    startTrackingLoop();
  }

  return { isActive, show, dismiss, takeAutoDismissed };
})();
