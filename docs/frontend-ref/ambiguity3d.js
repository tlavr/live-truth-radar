/* Live Truth Radar — Interactive 3D Ambiguity Surface Renderer
 * Draws the 2D (lag x semantic mismatch) histogram as an interactive 3D landscape:
 * - Drag to orbit or Arrow keys / 0 to reset (WCAG 2.2 AA accessible)
 * - Direct leader-line callouts pointing to the swarm peak, background carpet, and danger corner
 * - Interactive element focus highlighting ("peak" | "carpet" | "origin" | null)
 * - Hover picking with exact bin details
 */
(function (global) {
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function createAmbiguity3D(canvas, options = {}) {
    let finding = null;
    let mode = "combined"; // "combined" | "counts" | "background"
    let focusTarget = null; // "peak" | "carpet" | "origin" | null
    let yaw = -0.66;
    let pitch = 0.56;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let hoveredCell = null; // { r, c }
    let projectedBars = [];
    const showCallouts = options.showCallouts !== false;
    const canvasHeight = options.height || 410;

    const PRESETS = {
      iso: { yaw: -0.66, pitch: 0.56 },
      front: { yaw: -0.18, pitch: 0.28 },
      top: { yaw: -0.02, pitch: 1.38 },
      origin: { yaw: -0.78, pitch: 0.54 },
    };

    function css(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function isDark() {
      return document.documentElement.getAttribute("data-theme") === "dark";
    }

    function projectPoint(wx, wy, wz, cx, cy, scale) {
      const cyaw = Math.cos(yaw);
      const syaw = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);

      const rx = wx * cyaw - wz * syaw;
      const rz = wx * syaw + wz * cyaw;

      const ry = wy * cp - rz * sp;
      const depth = wy * sp + rz * cp;

      const camDist = 6.2;
      const persp = camDist / Math.max(1.5, camDist - depth * 0.42);
      return {
        x: cx + rx * scale * persp,
        y: cy - ry * scale * persp,
        depth,
      };
    }

    function drawPoly(ctx, pts, fill, stroke, lineWidth = 0.75) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
    }

    function drawRoundedRect(ctx, x, y, w, h, r) {
      const rad = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.lineTo(x + w - rad, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
      ctx.lineTo(x + w, y + h - rad);
      ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      ctx.lineTo(x + rad, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
      ctx.lineTo(x, y + rad);
      ctx.quadraticCurveTo(x, y, x + rad, y);
      ctx.closePath();
    }

    function pointInQuad(px, py, pts) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x;
        const yi = pts[i].y;
        const xj = pts[j].x;
        const yj = pts[j].y;
        const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function barColors(kind, t, hovered, dimmed) {
      const dark = isDark();
      const boost = hovered ? 0.14 : 0;
      const alphaScale = dimmed ? 0.24 : 1;
      if (kind === "swarm") {
        const r = 255;
        const g = Math.round(clamp(165 - t * 115 + boost * 80, 35, 220));
        const b = Math.round(clamp(48 - t * 20, 20, 80));
        return {
          top: `rgba(${r}, ${Math.min(255, g + 26)}, ${b + 16}, ${(0.98 * alphaScale).toFixed(2)})`,
          left: `rgba(${r}, ${g}, ${b}, ${(0.94 * alphaScale).toFixed(2)})`,
          right: `rgba(${Math.round(r * 0.78)}, ${Math.round(g * 0.74)}, ${Math.round(b * 0.74)}, ${(0.94 * alphaScale).toFixed(2)})`,
          stroke: hovered ? "#ffffff" : dark ? `rgba(255,255,255,${(0.2 * alphaScale).toFixed(2)})` : `rgba(0,0,0,${(0.12 * alphaScale).toFixed(2)})`,
        };
      }
      const r = dark ? 48 : 56;
      const g = dark ? 132 : 138;
      const b = dark ? 235 : 245;
      const alpha = clamp(0.28 + t * 0.45 + boost, 0.25, 0.88) * alphaScale;
      return {
        top: `rgba(${r + 30}, ${g + 26}, ${b}, ${alpha.toFixed(2)})`,
        left: `rgba(${r}, ${g}, ${b}, ${(alpha * 0.92).toFixed(2)})`,
        right: `rgba(${Math.round(r * 0.75)}, ${Math.round(g * 0.78)}, ${Math.round(b * 0.85)}, ${(alpha * 0.92).toFixed(2)})`,
        stroke: hovered ? "#ffffff" : dark ? `rgba(255,255,255,${(0.14 * alphaScale).toFixed(2)})` : `rgba(0,0,0,${(0.1 * alphaScale).toFixed(2)})`,
      };
    }

    function drawBox(ctx, x0, x1, z0, z1, y0, y1, cx, cy, scale, colors) {
      const b00 = projectPoint(x0, y0, z0, cx, cy, scale);
      const b10 = projectPoint(x1, y0, z0, cx, cy, scale);
      const b11 = projectPoint(x1, y0, z1, cx, cy, scale);
      const b01 = projectPoint(x0, y0, z1, cx, cy, scale);

      const t00 = projectPoint(x0, y1, z0, cx, cy, scale);
      const t10 = projectPoint(x1, y1, z0, cx, cy, scale);
      const t11 = projectPoint(x1, y1, z1, cx, cy, scale);
      const t01 = projectPoint(x0, y1, z1, cx, cy, scale);

      const faces = [
        { pts: [t00, t10, t11, t01], fill: colors.top },
        { pts: [b00, b10, t10, t00], fill: colors.left },
        { pts: [b01, b11, t11, t01], fill: colors.left },
        { pts: [b00, b01, t01, t00], fill: colors.right },
        { pts: [b10, b11, t11, t10], fill: colors.right },
      ].map((face) => ({
        ...face,
        avgDepth: face.pts.reduce((s, p) => s + p.depth, 0) / 4,
      }));

      faces.sort((a, b) => a.avgDepth - b.avgDepth);
      const visible = faces.slice(-3);
      visible.forEach((f) => drawPoly(ctx, f.pts, f.fill, colors.stroke));
      return visible.map((f) => f.pts);
    }

    function drawCallout(ctx, anchor, boxX, boxY, alignLeft, title, subtitle, accentColor, active) {
      const dark = isDark();
      const fontSans = css("--font-sans") || "sans-serif";
      const textPrimary = css("--text-primary") || (dark ? "#f5f5f7" : "#1d1d1f");
      const textSecondary = css("--text-secondary") || (dark ? "#aeaeb2" : "#59595e");

      ctx.save();
      ctx.font = `700 12px ${fontSans}`;
      const w1 = ctx.measureText ? ctx.measureText(title).width : title.length * 7;
      ctx.font = `500 11px ${fontSans}`;
      const w2 = subtitle && ctx.measureText ? ctx.measureText(subtitle).width : (subtitle ? subtitle.length * 6 : 0);

      const padX = 10;
      const boxW = Math.max(128, Math.max(w1, w2) + padX * 2);
      const boxH = subtitle ? 40 : 26;
      const finalX = clamp(alignLeft ? boxX - boxW : boxX, 8, (ctx.canvasWidth || 640) - boxW - 8);
      const finalY = clamp(boxY - boxH / 2, 8, (ctx.canvasHeight || 410) - boxH - 8);

      const edgeX = anchor.x < finalX + boxW / 2 ? finalX : finalX + boxW;
      const edgeY = finalY + boxH / 2;

      // Leader line
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = active ? 2.2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(anchor.x, anchor.y);
      ctx.lineTo((anchor.x + edgeX) * 0.5, edgeY);
      ctx.lineTo(edgeX, edgeY);
      ctx.stroke();

      // Anchor dot on 3D element
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, active ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = dark ? "#1c1c1e" : "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Label pill
      drawRoundedRect(ctx, finalX, finalY, boxW, boxH, 9);
      ctx.fillStyle = dark ? "rgba(28, 28, 30, 0.92)" : "rgba(255, 255, 255, 0.94)";
      ctx.fill();
      ctx.strokeStyle = active ? accentColor : dark ? "rgba(255,255,255,0.18)" : "rgba(60,60,67,0.18)";
      ctx.lineWidth = active ? 1.8 : 1;
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = textPrimary;
      ctx.font = `700 12px ${fontSans}`;
      ctx.fillText(title, finalX + padX, finalY + (subtitle ? 13 : boxH / 2));

      if (subtitle) {
        ctx.fillStyle = textSecondary;
        ctx.font = `500 11px ${fontSans}`;
        ctx.fillText(subtitle, finalX + padX, finalY + 28);
      }
      ctx.restore();
    }

    function render() {
      if (!canvas || !finding || !finding.ambiguity) return;
      const amb = finding.ambiguity;
      const rows = amb.mismatch_edges.length - 1;
      const cols = amb.lag_edges_sec.length - 1;
      const bg = amb.background || Array.from({ length: rows }, () => Array(cols).fill(0));

      const dpr = window.devicePixelRatio || 1;
      const width = (canvas.parentElement && canvas.parentElement.clientWidth) || 700;
      const height = canvasHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext("2d");
      ctx.canvasWidth = width;
      ctx.canvasHeight = height;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const cx = width * 0.5;
      const cy = height * 0.64;
      const scale = Math.min(width * 0.23, height * 0.42);
      const gridW = 2.5;
      const gridD = 1.65;
      const maxH = 1.38;

      let maxVal = 1;
      let totalSwarmPairs = 0;
      let peakCell = { r: 0, c: 0, sVal: -1, total: -1 };
      let bgSample = { r: 3, c: 6, bVal: -1 };

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sVal = amb.counts[r][c];
          const bVal = bg[r][c];
          totalSwarmPairs += sVal;
          const visibleHeight = mode === "counts" ? sVal : mode === "background" ? bVal : sVal + bVal;
          maxVal = Math.max(maxVal, visibleHeight);
          if (sVal > peakCell.sVal || (sVal === peakCell.sVal && visibleHeight > peakCell.total)) {
            peakCell = { r, c, sVal, bVal, total: visibleHeight };
          }
          if ((r >= 2 || c >= 3) && bVal > bgSample.bVal) {
            bgSample = { r, c, sVal, bVal };
          }
        }
      }

      if (bgSample.bVal <= 0) {
        bgSample = { r: Math.min(3, rows - 1), c: Math.min(6, cols - 1), sVal: 0, bVal: bg[Math.min(3, rows - 1)][Math.min(6, cols - 1)] || 0 };
      }

      // Draw 3D base plate & grid
      const pBL = projectPoint(-gridW / 2, 0, -gridD / 2, cx, cy, scale);
      const pBR = projectPoint(gridW / 2, 0, -gridD / 2, cx, cy, scale);
      const pTR = projectPoint(gridW / 2, 0, gridD / 2, cx, cy, scale);
      const pTL = projectPoint(-gridW / 2, 0, gridD / 2, cx, cy, scale);
      drawPoly(ctx, [pBL, pBR, pTR, pTL], css("--heat-empty"), css("--separator-strong"));

      ctx.strokeStyle = css("--grid-floor");
      ctx.lineWidth = 0.75;
      for (let c = 1; c < cols; c += 2) {
        const x = -gridW / 2 + (c / cols) * gridW;
        const a = projectPoint(x, 0, -gridD / 2, cx, cy, scale);
        const b = projectPoint(x, 0, gridD / 2, cx, cy, scale);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (let r = 1; r < rows; r++) {
        const z = -gridD / 2 + (r / rows) * gridD;
        const a = projectPoint(-gridW / 2, 0, z, cx, cy, scale);
        const b = projectPoint(gridW / 2, 0, z, cx, cy, scale);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      const cellW = gridW / cols;
      const cellD = gridD / rows;
      const padX = cellW * 0.14;
      const padZ = cellD * 0.14;

      // Danger corner floor highlight (|tau| < 60s, mismatch < 0.2)
      const oX0 = -gridW / 2;
      const oX1 = -gridW / 2 + cellW * 2;
      const oZ0 = -gridD / 2;
      const oZ1 = -gridD / 2 + cellD * 2;
      const dangerPts = [
        projectPoint(oX0, 0.005, oZ0, cx, cy, scale),
        projectPoint(oX1, 0.005, oZ0, cx, cy, scale),
        projectPoint(oX1, 0.005, oZ1, cx, cy, scale),
        projectPoint(oX0, 0.005, oZ1, cx, cy, scale),
      ];
      const originFocused = focusTarget === "origin";
      drawPoly(
        ctx,
        dangerPts,
        originFocused ? "rgba(255, 59, 48, 0.26)" : "rgba(255, 59, 48, 0.1)",
        css("--red") || "#ff3b30",
        originFocused ? 2 : 1
      );

      const items = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sVal = amb.counts[r][c];
          const bVal = bg[r][c];
          const hasBar = mode === "counts" ? sVal > 0 : mode === "background" ? bVal > 0 : sVal + bVal > 0;
          if (!hasBar) continue;
          const wx = -gridW / 2 + (c + 0.5) * cellW;
          const wz = -gridD / 2 + (r + 0.5) * cellD;
          const p = projectPoint(wx, 0, wz, cx, cy, scale);
          items.push({ r, c, sVal, bVal, wx, wz, depth: p.depth });
        }
      }
      items.sort((a, b) => a.depth - b.depth);

      projectedBars = [];
      items.forEach((cell) => {
        const x0 = cell.wx - cellW / 2 + padX;
        const x1 = cell.wx + cellW / 2 - padX;
        const z0 = cell.wz - cellD / 2 + padZ;
        const z1 = cell.wz + cellD / 2 - padZ;
        const isHovered = hoveredCell && hoveredCell.r === cell.r && hoveredCell.c === cell.c;
        const dimBg = focusTarget === "peak" || (focusTarget === "origin" && (cell.r > 1 || cell.c > 1));
        const dimSwarm = focusTarget === "carpet" || (focusTarget === "origin" && (cell.r > 1 || cell.c > 1));
        let hitPolys = [];

        if (mode === "background") {
          const h = (cell.bVal / maxVal) * maxH;
          hitPolys = drawBox(
            ctx, x0, x1, z0, z1, 0, h, cx, cy, scale,
            barColors("bg", cell.bVal / maxVal, isHovered, dimBg)
          );
        } else if (mode === "counts") {
          const h = (cell.sVal / maxVal) * maxH;
          hitPolys = drawBox(
            ctx, x0, x1, z0, z1, 0, h, cx, cy, scale,
            barColors("swarm", cell.sVal / maxVal, isHovered, dimSwarm)
          );
        } else {
          let yBase = 0;
          if (cell.bVal > 0) {
            const hb = (cell.bVal / maxVal) * maxH;
            hitPolys.push(
              ...drawBox(
                ctx, x0, x1, z0, z1, 0, hb, cx, cy, scale,
                barColors("bg", cell.bVal / maxVal, isHovered, dimBg)
              )
            );
            yBase = hb;
          }
          if (cell.sVal > 0) {
            const hs = (cell.sVal / maxVal) * maxH;
            hitPolys.push(
              ...drawBox(
                ctx, x0, x1, z0, z1, yBase, yBase + hs, cx, cy, scale,
                barColors("swarm", cell.sVal / maxVal, isHovered, dimSwarm)
              )
            );
          }
        }

        projectedBars.push({
          r: cell.r,
          c: cell.c,
          sVal: cell.sVal,
          bVal: cell.bVal,
          polys: hitPolys,
        });
      });

      // Clear axis annotations
      const fontMono = css("--font-mono") || "monospace";
      const fontSans = css("--font-sans") || "sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const pOrigin = projectPoint(-gridW / 2, 0, -gridD / 2, cx, cy, scale);
      const pLagEnd = projectPoint(gridW / 2, 0, -gridD / 2, cx, cy, scale);
      const pMisEnd = projectPoint(-gridW / 2, 0, gridD / 2, cx, cy, scale);
      const pLagMid = projectPoint(0, 0, -gridD / 2 - 0.24, cx, cy, scale);
      const pMisMid = projectPoint(-gridW / 2 - 0.36, 0, 0, cx, cy, scale);

      ctx.font = `700 11px ${fontMono}`;
      ctx.fillStyle = css("--red-text") || "#c92017";
      ctx.fillText("0с · 0.0 (зона роя)", pOrigin.x, pOrigin.y + 15);
      ctx.fillStyle = css("--text-secondary");
      ctx.font = `600 11px ${fontMono}`;
      ctx.fillText("10 мин", pLagEnd.x, pLagEnd.y + 15);
      ctx.fillText("1.0", pMisEnd.x - 14, pMisEnd.y + 12);

      ctx.font = `600 11.5px ${fontSans}`;
      ctx.fillText("Время ответа |τ| →", pLagMid.x, pLagMid.y + 8);
      ctx.fillText("Разница смысла 1−cos →", pMisMid.x, pMisMid.y);

      const pTop = projectPoint(-gridW / 2, maxH, -gridD / 2, cx, cy, scale);
      ctx.strokeStyle = css("--separator-strong");
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pOrigin.x, pOrigin.y);
      ctx.lineTo(pTop.x, pTop.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css("--text-secondary");
      ctx.font = `600 11px ${fontMono}`;
      ctx.fillText(`макс ${maxVal} пар`, pTop.x - 10, pTop.y - 10);

      // Direct 3D Callouts pointing at actual elements
      if (showCallouts) {
        if (mode !== "background") {
          const pwX = -gridW / 2 + (peakCell.c + 0.5) * cellW;
          const pwZ = -gridD / 2 + (peakCell.r + 0.5) * cellD;
          const peakHeightNorm = mode === "counts" ? peakCell.sVal / maxVal : (peakCell.sVal + (peakCell.bVal || 0)) / maxVal;
          const pPeakTop = projectPoint(pwX, clamp(peakHeightNorm * maxH, 0.06, maxH), pwZ, cx, cy, scale);
          const verdict = finding.verdict;
          let peakTitle = "Острый пик роя";
          let peakSub = `${peakCell.sVal} пар · 0–30 с, один смысл`;
          let peakColor = css("--red") || "#ff3b30";
          if (verdict === "watching") {
            peakTitle = finding.note ? "Всплеск (эхо новости)" : "Слабый пик (наблюдаем)";
            peakSub = `${peakCell.sVal} пар · копим данные`;
            peakColor = css("--amber") || "#ff9500";
          } else if (verdict === "organic" || totalSwarmPairs <= 2) {
            peakTitle = "Пика роя нет";
            peakSub = "Люди пишут с паузами вразнобой";
            peakColor = css("--green") || "#34c759";
          }
          drawCallout(
            ctx,
            pPeakTop,
            Math.max(14, pPeakTop.x - 74),
            Math.max(30, pPeakTop.y - 34),
            true,
            peakTitle,
            peakSub,
            peakColor,
            focusTarget === "peak"
          );
        }

        if (mode !== "counts") {
          const bwX = -gridW / 2 + (bgSample.c + 0.5) * cellW;
          const bwZ = -gridD / 2 + (bgSample.r + 0.5) * cellD;
          const bNorm = (bgSample.bVal || 1) / maxVal;
          const pBgTop = projectPoint(bwX, clamp(bNorm * maxH, 0.04, maxH), bwZ, cx, cy, scale);
          drawCallout(
            ctx,
            pBgTop,
            Math.min(width - 150, pBgTop.x + 68),
            Math.max(58, pBgTop.y - 36),
            false,
            "Живой фон (ковёр)",
            `~${bgSample.bVal || 1} пар · обычный спор`,
            css("--accent") || "#007aff",
            focusTarget === "carpet"
          );
        }

        if (focusTarget === "origin") {
          const pCorner = projectPoint(-gridW / 2 + cellW, 0.02, -gridD / 2 + cellD, cx, cy, scale);
          drawCallout(
            ctx,
            pCorner,
            Math.max(20, pCorner.x - 56),
            Math.min(height - 34, pCorner.y + 42),
            true,
            "Угол координации (0 с, 0.0)",
            "Здесь сходятся синхронные посты",
            css("--red") || "#ff3b30",
            true
          );
        }
      }
    }

    function pickCell(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      for (let i = projectedBars.length - 1; i >= 0; i--) {
        const bar = projectedBars[i];
        if (bar.polys.some((poly) => pointInQuad(px, py, poly))) {
          return bar;
        }
      }
      return null;
    }

    canvas.setAttribute("role", "img");
    if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
    if (!canvas.hasAttribute("aria-label")) {
      canvas.setAttribute(
        "aria-label",
        "3D-тело неопределённости: задержка во времени и смысловое расхождение. Вращение мышью или клавишами-стрелками, 0 — сброс ракурса."
      );
    }

    canvas.addEventListener("pointerdown", (ev) => {
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      canvas.classList.add("is-dragging");
      canvas.setPointerCapture(ev.pointerId);
    });

    canvas.addEventListener("pointermove", (ev) => {
      if (dragging) {
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        yaw += dx * 0.008;
        pitch = clamp(pitch + dy * 0.007, 0.18, 1.48);
        hoveredCell = null;
        if (options.onHover) options.onHover(null, ev);
        render();
        return;
      }

      const hit = pickCell(ev.clientX, ev.clientY);
      const changed = (hit?.r ?? -1) !== (hoveredCell?.r ?? -1) || (hit?.c ?? -1) !== (hoveredCell?.c ?? -1);
      hoveredCell = hit ? { r: hit.r, c: hit.c } : null;
      if (changed) render();
      if (options.onHover) options.onHover(hit, ev);
    });

    canvas.addEventListener("pointerup", (ev) => {
      dragging = false;
      canvas.classList.remove("is-dragging");
      if (canvas.hasPointerCapture(ev.pointerId)) {
        canvas.releasePointerCapture(ev.pointerId);
      }
    });

    canvas.addEventListener("pointerleave", () => {
      dragging = false;
      canvas.classList.remove("is-dragging");
      if (hoveredCell) {
        hoveredCell = null;
        render();
      }
      if (options.onHover) options.onHover(null);
    });

    canvas.addEventListener("keydown", (ev) => {
      const stepYaw = 0.12;
      const stepPitch = 0.08;
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        yaw -= stepYaw;
        render();
      } else if (ev.key === "ArrowRight") {
        ev.preventDefault();
        yaw += stepYaw;
        render();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        pitch = clamp(pitch + stepPitch, 0.18, 1.48);
        render();
      } else if (ev.key === "ArrowDown") {
        ev.preventDefault();
        pitch = clamp(pitch - stepPitch, 0.18, 1.48);
        render();
      } else if (ev.key === "0" || ev.key === "r" || ev.key === "R") {
        ev.preventDefault();
        yaw = PRESETS.iso.yaw;
        pitch = PRESETS.iso.pitch;
        render();
      }
    });

    return {
      update(newFinding, newMode) {
        finding = newFinding;
        if (newMode) mode = newMode;
        render();
      },
      setMode(newMode) {
        mode = newMode;
        render();
      },
      setFocus(target) {
        focusTarget = target || null;
        render();
      },
      setPreset(name) {
        const p = PRESETS[name];
        if (!p) return;
        yaw = p.yaw;
        pitch = p.pitch;
        render();
      },
      render,
    };
  }

  global.LTRAmbiguity3D = { createAmbiguity3D };
})(window);
