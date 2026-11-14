/* Live Truth Radar — Page #3: Full Details (Correlation Heatmap, SPRT, All Posts, Source Trust) */
(function () {
  const {
    bindThemeButtons,
    loadDataset,
    getQueryParam,
    escapeHtml,
    cssVar,
    maskHandle,
    formatUtcTime,
    verdictMeta,
    sortFindings,
    syncNavLinks,
  } = window.LTRShared;

  const data = loadDataset();
  const findings = sortFindings(data.alerts.findings || []);
  const state = {
    selectedId: getQueryParam("id") || findings[0]?.id || null,
    maskHandles: true,
    sprtChart: null,
  };

  function getSelected() {
    return findings.find((f) => f.id === state.selectedId) || findings[0] || null;
  }

  function renderSwitcher(selected) {
    const el = document.getElementById("case-switcher");
    el.innerHTML = findings
      .map((f) => {
        const vm = verdictMeta(f.verdict);
        const active = selected && selected.id === f.id;
        return `
          <button type="button" class="pill-btn ${active ? "is-active" : ""}" data-case-id="${escapeHtml(f.id)}">
            <span>${vm.icon}</span>
            <span>${escapeHtml(f.topic)}</span>
            <span class="pill-count num">${f.accounts.length} акк.</span>
          </button>
        `;
      })
      .join("");

    el.querySelectorAll("[data-case-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedId = btn.dataset.caseId;
        render();
      });
    });
  }

  function renderStats(finding) {
    const el = document.getElementById("stats-strip");
    if (!finding) {
      el.innerHTML = "";
      return;
    }

    const snrSingle = finding.snr_db_single != null ? `${finding.snr_db_single.toFixed(1)}` : "—";
    const snrTotal = finding.snr_db.toFixed(1);
    const gain = finding.snr_db_single != null ? `+${(finding.snr_db - finding.snr_db_single).toFixed(1)} дБ` : "—";
    const decided = finding.decided_at_item != null ? `пост #${finding.decided_at_item + 1}` : "наблюдаем";
    const pairs = (finding.accounts.length * (finding.accounts.length - 1)) / 2;

    const tiles = [
      { label: "SNR до → после", value: `${snrSingle} → ${snrTotal} дБ`, hint: `Выигрыш: ${gain}` },
      { label: "Накопленный LLR", value: finding.llr.toFixed(2), hint: `Пороги [${finding.sprt_lower.toFixed(2)}, +${finding.sprt_upper.toFixed(2)}]` },
      { label: "Момент решения", value: decided, hint: `Наблюдений: ${finding.sprt_trace.length}` },
      { label: "Пар / Аккаунтов", value: `${pairs} / ${finding.accounts.length}`, hint: `Постов: ${finding.item_ids.length}` },
    ];

    el.innerHTML = tiles
      .map(
        (t) => `
      <div class="card stat-tile">
        <div class="stat-label">${escapeHtml(t.label)}</div>
        <div class="stat-value num">${escapeHtml(t.value)}</div>
        <div class="stat-hint num">${escapeHtml(t.hint)}</div>
      </div>
    `
      )
      .join("");

    document.getElementById("sprt-decision-tag").textContent =
      finding.decided_at_item != null ? `Решение: пост #${finding.decided_at_item + 1}` : "Порог не пересечён";
  }

  function heatBlue(t) {
    const c = Math.max(0, Math.min(1, t));
    if (c === 0) return cssVar("--heat-empty");
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    const r = Math.round(dark ? 10 + c * 140 : 0 + c * 88);
    const g = Math.round(dark ? 132 - c * 40 : 122 - c * 40);
    const b = dark ? 255 : 235;
    return `rgba(${r}, ${g}, ${b}, ${0.18 + c * 0.82})`;
  }

  function drawCorrelation(finding) {
    const canvas = document.getElementById("corr-canvas");
    if (!canvas || !finding) return;

    const corr = finding.correlation;
    const lag = finding.lag_sec;
    const n = finding.accounts.length;
    const labels = finding.accounts.map((a) => maskHandle(a, finding.synthetic, state.maskHandles));

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement.clientWidth || 460;
    const height = 280;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const pad = { top: 10, right: 12, bottom: 44, left: 88 };
    const size = Math.min(width - pad.left - pad.right, height - pad.top - pad.bottom);
    const offsetX = pad.left + (width - pad.left - pad.right - size) / 2;
    const cell = size / n;

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const val = corr[i][j];
        ctx.fillStyle = heatBlue(val);
        const x = offsetX + j * cell;
        const y = pad.top + i * cell;
        ctx.fillRect(x + 1, y + 1, Math.max(1, cell - 2), Math.max(1, cell - 2));

        if (cell >= 30) {
          ctx.fillStyle = val > 0.55 ? "#ffffff" : cssVar("--text-primary");
          ctx.font = `600 11px ${cssVar("--font-mono")}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(val.toFixed(2), x + cell / 2, y + cell / 2);
        }
      }
    }

    ctx.fillStyle = cssVar("--text-secondary");
    ctx.font = `11px ${cssVar("--font-mono")}`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i < n; i++) {
      ctx.fillText(labels[i].slice(0, 11), offsetX - 8, pad.top + i * cell + cell / 2);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let j = 0; j < n; j++) {
      ctx.fillText(labels[j].slice(0, 7), offsetX + j * cell + cell / 2, pad.top + size + 8);
    }

    const gradEl = document.getElementById("corr-legend-grad");
    if (gradEl) {
      gradEl.style.background = `linear-gradient(90deg, ${cssVar("--heat-empty")}, rgba(0,122,255,0.5), rgba(88,86,214,1))`;
    }

    const tooltip = document.getElementById("tooltip");
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left - offsetX;
      const y = ev.clientY - rect.top - pad.top;
      if (x < 0 || y < 0 || x >= size || y >= size) {
        tooltip.classList.remove("is-visible");
        return;
      }
      const j = Math.min(n - 1, Math.floor(x / cell));
      const i = Math.min(n - 1, Math.floor(y / cell));
      const lagStr = lag ? ` · lag = ${lag[i][j] > 0 ? "+" : ""}${lag[i][j]} с` : "";
      tooltip.innerHTML =
        `<div class="mono">${escapeHtml(labels[i])} ↔ ${escapeHtml(labels[j])}</div>`
        + `<div>R = <strong>${corr[i][j].toFixed(2)}</strong>${lagStr}</div>`;
      tooltip.classList.add("is-visible");
      tooltip.style.left = `${ev.clientX + 12}px`;
      tooltip.style.top = `${ev.clientY - 46}px`;
    };
    canvas.onmouseleave = () => tooltip.classList.remove("is-visible");
  }

  function drawSprt(finding) {
    const canvas = document.getElementById("sprt-canvas");
    if (!canvas || !finding) return;

    if (state.sprtChart) {
      state.sprtChart.destroy();
      state.sprtChart = null;
    }

    const labels = finding.sprt_trace.map((_, idx) => `#${idx + 1}`);
    const upper = finding.sprt_trace.map(() => finding.sprt_upper);
    const lower = finding.sprt_trace.map(() => finding.sprt_lower);
    const accent = cssVar("--accent");
    const red = cssVar("--red");
    const green = cssVar("--green");
    const textSec = cssVar("--text-secondary");
    const gridColor = cssVar("--chart-grid");

    if (typeof window.Chart === "function") {
      const pointRadii = finding.sprt_trace.map((_, idx) => (idx === finding.decided_at_item ? 6 : 3));
      const pointColors = finding.sprt_trace.map((_, idx) => (idx === finding.decided_at_item ? red : accent));

      state.sprtChart = new window.Chart(canvas, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Λ (LLR)",
              data: finding.sprt_trace,
              borderColor: accent,
              backgroundColor: accent,
              borderWidth: 2.5,
              tension: 0.22,
              pointRadius: pointRadii,
              pointBackgroundColor: pointColors,
            },
            {
              label: `Coordinated (+${finding.sprt_upper.toFixed(2)})`,
              data: upper,
              borderColor: red,
              borderWidth: 1.5,
              borderDash: [6, 5],
              pointRadius: 0,
            },
            {
              label: `Organic (${finding.sprt_lower.toFixed(2)})`,
              data: lower,
              borderColor: green,
              borderWidth: 1.5,
              borderDash: [6, 5],
              pointRadius: 0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: textSec, boxWidth: 12, font: { size: 11 } } },
          },
          scales: {
            x: { ticks: { color: textSec }, grid: { color: gridColor } },
            y: {
              ticks: { color: textSec },
              grid: { color: gridColor },
              suggestedMin: finding.sprt_lower - 0.6,
              suggestedMax: finding.sprt_upper + 0.8,
            },
          },
        },
      });
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement.clientWidth || 440;
    const height = 280;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const pad = { top: 20, right: 16, bottom: 28, left: 42 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const minY = Math.min(finding.sprt_lower - 0.5, ...finding.sprt_trace);
    const maxY = Math.max(finding.sprt_upper + 0.5, ...finding.sprt_trace);
    const mapX = (idx) => pad.left + (idx / Math.max(1, finding.sprt_trace.length - 1)) * w;
    const mapY = (val) => pad.top + h - ((val - minY) / Math.max(1e-6, maxY - minY)) * h;

    [
      { val: finding.sprt_upper, color: red },
      { val: finding.sprt_lower, color: green },
    ].forEach((line) => {
      ctx.save();
      ctx.strokeStyle = line.color;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, mapY(line.val));
      ctx.lineTo(pad.left + w, mapY(line.val));
      ctx.stroke();
      ctx.restore();
    });

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    finding.sprt_trace.forEach((v, idx) => {
      const x = mapX(idx);
      const y = mapY(v);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function renderEvidence(finding) {
    const sec = document.getElementById("evidence-section");
    if (!finding) {
      sec.innerHTML = "";
      return;
    }

    const items = finding.item_ids.map((id) => data.itemsById.get(id)).filter(Boolean);
    const domainGuess = items.find((i) => i.source === "context_news")?.platform || "x";
    const trust = window.LTRMockData.sourceTrust[domainGuess] || window.LTRMockData.sourceTrust.x;

    sec.innerHTML = `
      <div class="card subcard" style="margin-bottom:20px;">
        <div class="subcard-header">
          <div>
            <h2 class="subcard-title">Аккаунты группы (${finding.accounts.length}) и источник (SHOULD S1)</h2>
            <p class="subcard-subtitle">В публичном режиме реальные хэндлы маскируются; ID кейса: <span class="mono">${escapeHtml(finding.id)}</span></p>
          </div>
          <span class="tag mono">GET /api/source/${escapeHtml(trust.domain)}</span>
        </div>

        <div class="accounts-wrap">
          ${finding.accounts
            .map((acc) => `<span class="account-chip mono">${escapeHtml(maskHandle(acc, finding.synthetic, state.maskHandles))}</span>`)
            .join("")}
        </div>

        <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--separator); font-size:13.5px; color:var(--text-secondary);">
          <strong>🔗 Источник:</strong> <span class="mono">${escapeHtml(trust.domain)}</span> — ${escapeHtml(trust.company)} (осн. ${escapeHtml(trust.founded)}). ${escapeHtml(trust.note)}.
        </div>
      </div>

      <div class="card subcard">
        <div class="subcard-header">
          <div>
            <h2 class="subcard-title">Все посты группы (${items.length})</h2>
            <p class="subcard-subtitle">Хронологическая выдача из <span class="mono">GET /api/items?ids=…</span></p>
          </div>
        </div>

        <div class="posts-grid">
          ${items
            .map((item) => {
              const handle = maskHandle(item.author, item.synthetic || finding.synthetic, state.maskHandles);
              return `
                <article class="post-row">
                  <div class="post-head">
                    <span class="post-author mono">${escapeHtml(handle)}</span>
                    <span class="post-time num">${escapeHtml(item.platform || item.source)} · ${formatUtcTime(item.published_at)}</span>
                  </div>
                  <p class="post-text">${escapeHtml(item.text)}</p>
                </article>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  }

  function render() {
    const selected = getSelected();
    syncNavLinks(selected?.id);
    renderSwitcher(selected);
    renderStats(selected);
    renderEvidence(selected);
    requestAnimationFrame(() => {
      drawCorrelation(selected);
      drawSprt(selected);
    });
  }

  bindThemeButtons(() => render());
  document.getElementById("mask-toggle").addEventListener("change", (ev) => {
    state.maskHandles = ev.target.checked;
    render();
  });
  window.addEventListener("resize", () => render());
  render();
})();
