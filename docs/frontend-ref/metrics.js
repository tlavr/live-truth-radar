/* Live Truth Radar — Metrics Page (/metrics) */
(function () {
  const { bindThemeButtons, escapeHtml, cssVar } = window.LTRShared;

  const state = {
    mode: "ready",
    rocChart: null,
    sizeChart: null,
  };

  function pct(val, digits = 1) {
    if (val == null) return "—";
    return `${(val * 100).toFixed(digits)}%`;
  }

  function getReport() {
    return state.mode === "ready"
      ? window.LTRMockData.metricsReady
      : window.LTRMockData.metricsPending;
  }

  function renderKpis(r) {
    const ci = r.live_precision_ci
      ? `95% CI (Вильсон): ${pct(r.live_precision_ci[0])} – ${pct(r.live_precision_ci[1])}`
      : "Ожидает разметки T14";
    const timeText = r.mean_seconds_to_decision != null
      ? `${r.mean_seconds_to_decision.toFixed(0)} с`
      : "—";
    const postsText = r.mean_posts_to_decision != null
      ? `${r.mean_posts_to_decision.toFixed(1)} постов`
      : "Данные появятся после make eval";

    const tiles = [
      {
        label: "Рабочая точка (Pfa → Pd)",
        value: `${pct(r.operating_pfa)} → ${pct(r.detection_rate)}`,
        hint: `Embedder: ${r.embedder || "не запущен"}`,
      },
      {
        label: "Время до решения",
        value: timeText,
        hint: postsText,
      },
      {
        label: "Live Precision (T14)",
        value: pct(r.live_precision),
        hint: ci,
      },
      {
        label: "Live FPR / Чистота роя",
        value: `${pct(r.live_fpr)} / ${pct(r.swarm_purity)}`,
        hint: `Размечено: ${r.n_labelled} аккаунтов`,
      },
    ];

    document.getElementById("kpi-grid").innerHTML = tiles
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

    document.getElementById("metrics-subtitle").textContent = r.embedder
      ? `embedder: ${r.embedder} · n_labelled = ${r.n_labelled}`
      : "eval/report.json не найден — показана заглушка API";

    const rocTag = document.getElementById("roc-point-tag");
    rocTag.textContent = r.operating_pfa != null && r.detection_rate != null
      ? `Pfa ${pct(r.operating_pfa)} · Pd ${pct(r.detection_rate)}`
      : "Нет данных";
  }

  function renderRoc(r) {
    const canvas = document.getElementById("roc-canvas");
    if (state.rocChart) {
      state.rocChart.destroy();
      state.rocChart = null;
    }

    const accent = cssVar("--accent");
    const red = cssVar("--red");
    const textSec = cssVar("--text-secondary");
    const gridColor = cssVar("--chart-grid");

    if (!r.roc || !r.roc.length) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const rocPoints = r.roc.map(([pfa, pd]) => ({ x: pfa * 100, y: pd * 100 }));
    const opPoint = r.operating_pfa != null && r.detection_rate != null
      ? [{ x: r.operating_pfa * 100, y: r.detection_rate * 100 }]
      : [];

    if (typeof window.Chart === "function") {
      state.rocChart = new window.Chart(canvas, {
        type: "line",
        data: {
          datasets: [
            {
              label: "ROC-кривая",
              data: rocPoints,
              borderColor: accent,
              backgroundColor: accent,
              borderWidth: 2.5,
              tension: 0.2,
              pointRadius: 3,
            },
            {
              label: "Рабочая точка (Pfa ≤ 2%)",
              data: opPoint,
              borderColor: red,
              backgroundColor: red,
              pointRadius: 7,
              showLine: false,
            },
            {
              label: "Случайный уровень",
              data: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
              borderColor: textSec,
              borderWidth: 1,
              borderDash: [5, 5],
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
            x: {
              type: "linear",
              min: 0,
              max: 20,
              title: { display: true, text: "Pfa (%)", color: textSec },
              ticks: { color: textSec },
              grid: { color: gridColor },
            },
            y: {
              type: "linear",
              min: 0,
              max: 100,
              title: { display: true, text: "Pd (%)", color: textSec },
              ticks: { color: textSec },
              grid: { color: gridColor },
            },
          },
        },
      });
      return;
    }

    // Offline Canvas fallback
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement.clientWidth || 440;
    const height = 280;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const pad = { top: 18, right: 18, bottom: 30, left: 38 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;

    ctx.strokeStyle = accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    rocPoints.forEach((p, idx) => {
      const x = pad.left + (Math.min(20, p.x) / 20) * w;
      const y = pad.top + h - (p.y / 100) * h;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    opPoint.forEach((p) => {
      ctx.fillStyle = red;
      ctx.beginPath();
      ctx.arc(pad.left + (p.x / 20) * w, pad.top + h - (p.y / 100) * h, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function renderSizeChart(r) {
    const canvas = document.getElementById("size-canvas");
    if (state.sizeChart) {
      state.sizeChart.destroy();
      state.sizeChart = null;
    }
    if (!r.pd_by_size || !r.pd_by_size.length) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const accent = cssVar("--accent");
    const textSec = cssVar("--text-secondary");
    const gridColor = cssVar("--chart-grid");
    const labels = r.pd_by_size.map(([n]) => `${n} акк.`);
    const vals = r.pd_by_size.map(([, pd]) => Math.round(pd * 100));

    if (typeof window.Chart === "function") {
      state.sizeChart = new window.Chart(canvas, {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: "Pd (%)",
              data: vals,
              backgroundColor: accent,
              borderRadius: 8,
              maxBarThickness: 44,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
          },
          scales: {
            x: { ticks: { color: textSec }, grid: { display: false } },
            y: {
              min: 0,
              max: 100,
              ticks: { color: textSec },
              grid: { color: gridColor },
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
    const pad = { top: 20, right: 16, bottom: 30, left: 36 };
    const w = width - pad.left - pad.right;
    const h = height - pad.top - pad.bottom;
    const bw = (w / vals.length) * 0.55;
    vals.forEach((v, idx) => {
      const cx = pad.left + (idx + 0.5) * (w / vals.length);
      const bh = (v / 100) * h;
      ctx.fillStyle = accent;
      ctx.fillRect(cx - bw / 2, pad.top + h - bh, bw, bh);
    });
  }

  function renderFailures(r) {
    const list = r.failure_examples || [];
    document.getElementById("failure-count").textContent = String(list.length);
    const wrap = document.getElementById("failure-table-wrap");
    if (!list.length) {
      wrap.innerHTML = `<div class="empty-state">Примеры ошибок появятся после запуска <code>make eval</code> (T13 / T14).</div>`;
      return;
    }

    wrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Тип</th>
            <th>Finding</th>
            <th>Аккаунт</th>
            <th>Комментарий</th>
          </tr>
        </thead>
        <tbody>
          ${list
            .map((ex) => {
              const badge = ex.kind === "false_positive"
                ? `<span class="verdict-badge verdict-watching"><span class="verdict-dot"></span>False Positive</span>`
                : `<span class="verdict-badge verdict-coordinated"><span class="verdict-dot"></span>False Negative</span>`;
              return `
                <tr>
                  <td>${badge}</td>
                  <td class="mono">${escapeHtml(ex.finding_id || "—")}</td>
                  <td class="mono">${escapeHtml(ex.account || "—")}</td>
                  <td>${escapeHtml(ex.note)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  function render() {
    const report = getReport();
    renderKpis(report);
    renderFailures(report);
    requestAnimationFrame(() => {
      renderRoc(report);
      renderSizeChart(report);
    });
  }

  bindThemeButtons(() => render());
  document.querySelectorAll("[data-report-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.reportMode;
      document.querySelectorAll("[data-report-mode]").forEach((b) => {
        b.classList.toggle("is-active", b.dataset.reportMode === state.mode);
      });
      render();
    });
  });
  window.addEventListener("resize", () => render());
  render();
})();
