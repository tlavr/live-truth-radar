/* Live Truth Radar — Page #1: Topic Input -> Centered Status Summary -> 3D Ambiguity Surface with Callouts */
(function () {
  const {
    bindThemeButtons,
    loadDataset,
    saveInjected,
    getQueryParam,
    escapeHtml,
    maskHandle,
    formatUtcTime,
    formatFreshness,
    verdictMeta,
    sortFindings,
    syncNavLinks,
  } = window.LTRShared;

  const data = loadDataset();
  const state = {
    alerts: data.alerts,
    itemsById: data.itemsById,
    metrics: window.LTRMockData.metricsReady,
    selectedFindingId: getQueryParam("id"),
    probeMode: "coordinated",
    ambMode: "combined",
    ambPreset: "iso",
    focusElement: null, // "peak" | "carpet" | "origin" | null
    injecting: false,
    viewer3D: null,
  };

  function getOperatingPfaPercent() {
    const pfa = state.metrics && typeof state.metrics.operating_pfa === "number"
      ? state.metrics.operating_pfa
      : 0.02;
    return (pfa * 100).toFixed(1).replace(/\.0$/, "");
  }

  function ensureSelection() {
    const all = sortFindings(state.alerts.findings || []);
    if (!all.length) {
      state.selectedFindingId = null;
      return null;
    }
    const found = all.find((f) => f.id === state.selectedFindingId);
    if (found) return found;
    state.selectedFindingId = all[0].id;
    return all[0];
  }

  function getPeakStats(finding) {
    const counts = (finding.ambiguity && finding.ambiguity.counts) || [[0]];
    const bg = (finding.ambiguity && finding.ambiguity.background) || [[0]];
    let maxSwarm = 0;
    let totalSwarm = 0;
    let maxBg = 0;
    let originSwarm = 0;
    for (let r = 0; r < counts.length; r++) {
      for (let c = 0; c < counts[r].length; c++) {
        const s = counts[r][c] || 0;
        const b = (bg[r] && bg[r][c]) || 0;
        totalSwarm += s;
        if (s > maxSwarm) maxSwarm = s;
        if (b > maxBg) maxBg = b;
        if (r <= 1 && c <= 1) originSwarm += s;
      }
    }
    return { maxSwarm, totalSwarm, maxBg, originSwarm };
  }

  function buildHumanStatus(finding) {
    const n = finding.accounts.length;
    if (finding.verdict === "coordinated") {
      return {
        badge: "Обнаружен скоординированный рой",
        headline: `${n} аккаунтов продвигают один сценарий почти одновременно`,
        lead: finding.explanation
          ? finding.explanation.summary
          : `Посты этой группы слишком синхронны по времени и близки по смыслу для обычной живой дискуссии.`,
        actionHint: "На графике ниже это видно как высокий красно-оранжевый пик в самом ближнем углу.",
      };
    }
    if (finding.verdict === "watching") {
      if (finding.note) {
        return {
          badge: "Всплеск похож на эхо новости",
          headline: `Люди синхронно реагируют на новость — тревогу не поднимаем`,
          lead: finding.note.replace(/^эхо новости:\s*/i, "")
            + " Защита от ложных срабатываний не даёт перевести живую реакцию в статус атаки.",
          actionHint: "Пик есть, но перед ним вышла крупная новость — радар продолжает наблюдение.",
        };
      }
      return {
        badge: "Наблюдаем — улик пока недостаточно",
        headline: `${n} аккаунтов выглядят подозрительно, но порог ещё не пройден`,
        lead: "Последовательный тест (SPRT) продолжает копить новые посты по этой теме, чтобы не ошибиться.",
        actionHint: "В углу графика виден небольшой холмик, который ещё не оторвался от живого фона.",
      };
    }
    return {
      badge: "Живое обсуждение — всё нормально",
      headline: `${n} участников обсуждают тему независимо и в разном темпе`,
      lead: "Смыслы и интервалы между постами распределены естественно — совпадений «под копирку» нет.",
      actionHint: "Ниже на 3D-поверхности виден только спокойный синий ковёр без острого пика.",
    };
  }

  function renderTopMeta() {
    const el = document.getElementById("freshness-label");
    if (el) el.textContent = formatFreshness(state.alerts.last_poll_at, state.alerts.generated_at);
  }

  function renderTopicControls(selected) {
    const all = sortFindings(state.alerts.findings || []);
    const pillsEl = document.getElementById("beam-pills");
    pillsEl.innerHTML = all
      .map((f) => {
        const vm = verdictMeta(f.verdict);
        const isActive = selected && selected.id === f.id;
        return `
          <button
            type="button"
            class="pill-btn ${isActive ? "is-active" : ""}"
            aria-pressed="${isActive}"
            data-select-finding="${escapeHtml(f.id)}"
          >
            <span aria-hidden="true">${vm.icon}</span>
            <span>${escapeHtml(f.topic)}</span>
            <span class="pill-count num">${f.accounts.length} акк.</span>
          </button>
        `;
      })
      .join("");

    pillsEl.querySelectorAll("[data-select-finding]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedFindingId = btn.dataset.selectFinding;
        state.focusElement = null;
        const next = ensureSelection();
        const input = document.getElementById("topic-input");
        if (input && next) input.value = next.topic;
        render();
      });
    });

    const input = document.getElementById("topic-input");
    if (input && selected && !input.value) {
      input.value = selected.topic;
    }
  }

  function renderCenterSummary(finding) {
    const container = document.getElementById("status-center");
    if (!finding) {
      container.innerHTML = `<div class="empty-state">Задайте тему выше или нажмите «Вбросить тестовый рой».</div>`;
      return;
    }

    const vm = verdictMeta(finding.verdict);
    const status = buildHumanStatus(finding);
    const exp = finding.explanation;
    const pfaPct = getOperatingPfaPercent();
    const idParam = `?id=${encodeURIComponent(finding.id)}`;
    const refPosts = finding.item_ids
      .map((id) => state.itemsById.get(id))
      .filter(Boolean)
      .slice(0, 3);
    const ratioBoost = Math.max(1, Math.round(Math.pow(10, (finding.snr_db || 0) / 20)));

    container.className = `card status-center-card status-tone-${escapeHtml(finding.verdict)}`;
    container.innerHTML = `
      <div class="status-center-top">
        <div class="verdict-pill ${vm.badgeClass}">
          <span class="verdict-dot" aria-hidden="true"></span>
          <span>${escapeHtml(status.badge)}</span>
        </div>
        <div class="status-topic-chip">
          <span>Тема:</span>
          <strong class="mono">${escapeHtml(finding.topic)}</strong>
          ${finding.synthetic ? `<span class="tag tag-purple">синтетика</span>` : ""}
        </div>
      </div>

      <h2 class="status-center-headline">${escapeHtml(status.headline)}</h2>
      <p class="status-center-lead">${escapeHtml(status.lead)}</p>

      ${exp ? `
        <div class="status-evidence-box">
          <div class="status-evidence-meta">
            <span class="technique-pill">${escapeHtml(exp.technique)}</span>
            <span class="confidence-pill num">Уверенность модели: <strong>${Math.round(exp.confidence * 100)}%</strong></span>
          </div>
          <blockquote class="quote-box">«${escapeHtml(exp.quote)}»</blockquote>
        </div>
      ` : ""}

      <div class="status-kpi-row">
        <div class="status-kpi">
          <span class="status-kpi-label">Подозреваемая группа</span>
          <strong class="status-kpi-val num">${finding.accounts.length} акк.</strong>
          <span class="status-kpi-note num">${finding.item_ids.length} постов в окне</span>
        </div>
        <div class="status-kpi">
          <span class="status-kpi-label">Сила пика над фоном</span>
          <strong class="status-kpi-val num">${finding.snr_db.toFixed(1)} дБ</strong>
          <span class="status-kpi-note">примерно в ${ratioBoost}× громче фона</span>
        </div>
        <div class="status-kpi">
          <span class="status-kpi-label">Гарантия точности (SPRT)</span>
          <strong class="status-kpi-val num">Λ = ${finding.llr.toFixed(2)}</strong>
          <span class="status-kpi-note">риск ложной тревоги ≤ ${pfaPct}%</span>
        </div>
      </div>

      ${refPosts.length ? `
        <details class="ref-posts-details">
          <summary>Посмотреть примеры постов (${refPosts.length} из ${finding.item_ids.length})</summary>
          <div class="ref-posts-stack">
            ${refPosts.map((item) => `
              <div class="ref-post-mini">
                <div class="ref-post-head">
                  <span class="mono">${escapeHtml(maskHandle(item.author, item.synthetic || finding.synthetic, true))}</span>
                  <span class="num">${formatUtcTime(item.published_at)}</span>
                </div>
                <div>${escapeHtml(item.text)}</div>
              </div>
            `).join("")}
          </div>
        </details>
      ` : ""}

      <div class="status-center-actions">
        <a class="btn btn-primary" href="how.html${idParam}">Как это работает на пальцах ›</a>
        <a class="btn btn-secondary" href="details.html${idParam}">Матрица и все посты (${finding.item_ids.length})</a>
        <a class="btn btn-ghost" href="#ambiguity-showcase">Разобрать 3D-график ↓</a>
      </div>
    `;
  }

  function renderAmbiguityShowcase(finding) {
    const wrap = document.getElementById("ambiguity-showcase");
    if (!finding) {
      wrap.innerHTML = "";
      return;
    }

    const peak = getPeakStats(finding);
    const isCoordinated = finding.verdict === "coordinated";
    const isWatching = finding.verdict === "watching";

    const peakDesc = isCoordinated
      ? `Здесь собралось ${peak.maxSwarm} совпадающих пар в одном бине (всего в углу роя — ${peak.originSwarm}). Так выглядит скоординированная атака.`
      : isWatching
        ? `Всплеск есть (${peak.maxSwarm} пар), но он ниже порога или совпал с новостью — радар не делает поспешных выводов.`
        : `Высокого пика в углу нет (максимум ${peak.maxSwarm} пары) — это признак обычной человеческой дискуссии.`;

    wrap.innerHTML = `
      <div class="showcase-header">
        <div>
          <h2 class="stage-title">3D-тело неопределённости: что происходит на графике</h2>
          <p class="stage-caption">
            Наглядная карта совпадений: впереди — похожие посты за секунды, по всему полю — спокойный фон темы.
            Крутите 3D мышью или стрелками клавиатуры.
          </p>
        </div>

        <div class="stage-controls">
          <div class="segmented" role="group" aria-label="Слой 3D-сцены">
            <button type="button" class="segmented-item ${state.ambMode === "combined" ? "is-active" : ""}" aria-pressed="${state.ambMode === "combined"}" data-amb-mode="combined">Всё вместе</button>
            <button type="button" class="segmented-item ${state.ambMode === "counts" ? "is-active" : ""}" aria-pressed="${state.ambMode === "counts"}" data-amb-mode="counts">Только рой</button>
            <button type="button" class="segmented-item ${state.ambMode === "background" ? "is-active" : ""}" aria-pressed="${state.ambMode === "background"}" data-amb-mode="background">Только фон</button>
          </div>
          <div class="segmented" role="group" aria-label="Ракурс камеры">
            <button type="button" class="segmented-item ${state.ambPreset === "iso" ? "is-active" : ""}" aria-pressed="${state.ambPreset === "iso"}" data-preset="iso">3D</button>
            <button type="button" class="segmented-item ${state.ambPreset === "front" ? "is-active" : ""}" aria-pressed="${state.ambPreset === "front"}" data-preset="front">Сбоку</button>
            <button type="button" class="segmented-item ${state.ambPreset === "top" ? "is-active" : ""}" aria-pressed="${state.ambPreset === "top"}" data-preset="top">Сверху</button>
          </div>
        </div>
      </div>

      <div class="stage-3d-panel stage-3d-panel-wide">
        <div class="canvas-3d-wrap canvas-3d-wrap-wide">
          <canvas id="ambiguity-3d-canvas" class="canvas-3d canvas-3d-wide"></canvas>
        </div>

        <div class="stage-footer">
          <div class="legend-chips">
            <span class="legend-chip"><span class="swatch swatch-swarm"></span>Оранжево-красный пик = синхронная группа</span>
            <span class="legend-chip"><span class="swatch swatch-bg"></span>Синий ковёр = живой фон темы</span>
          </div>
          <span>Наведите на любой столбик для точных цифр · Нажмите на карточки ниже, чтобы подсветить элемент</span>
        </div>
      </div>

      <div class="callout-guide-section">
        <div class="callout-guide-header">
          <h3 class="callout-guide-title">Указатель элементов на 3D-графике</h3>
          ${state.focusElement ? `<button type="button" id="clear-focus-btn" class="btn btn-secondary btn-xs">Сбросить подсветку</button>` : `<span class="callout-guide-hint">Нажмите на карточку, чтобы подсветить элемент в 3D</span>`}
        </div>

        <div class="callout-guide-grid">
          <button
            type="button"
            class="callout-guide-card ${state.focusElement === "peak" ? "is-focused" : ""}"
            aria-pressed="${state.focusElement === "peak"}"
            data-focus-el="peak"
          >
            <span class="callout-num callout-num-red">1</span>
            <div class="callout-body">
              <strong>Вершина (острый пик)</strong>
              <p>${escapeHtml(peakDesc)}</p>
            </div>
          </button>

          <button
            type="button"
            class="callout-guide-card ${state.focusElement === "carpet" ? "is-focused" : ""}"
            aria-pressed="${state.focusElement === "carpet"}"
            data-focus-el="carpet"
          >
            <span class="callout-num callout-num-blue">2</span>
            <div class="callout-body">
              <strong>Синий «ковёр» (обычные люди)</strong>
              <p>Живой фон темы (до ${peak.maxBg} пар в клетке): пользователи отвечают с паузами от 2 до 10 минут и спорят по-разному.</p>
            </div>
          </button>

          <button
            type="button"
            class="callout-guide-card ${state.focusElement === "origin" ? "is-focused" : ""}"
            aria-pressed="${state.focusElement === "origin"}"
            data-focus-el="origin"
          >
            <span class="callout-num callout-num-amber">3</span>
            <div class="callout-body">
              <strong>Опасный угол (0 с · смысл 0.0)</strong>
              <p>Пересечение «ответили почти мгновенно» + «одинаковый смысл». Если башня растёт именно здесь — срабатывает радар.</p>
            </div>
          </button>
        </div>
      </div>
    `;

    const canvas = document.getElementById("ambiguity-3d-canvas");
    const tooltip = document.getElementById("tooltip");
    state.viewer3D = window.LTRAmbiguity3D.createAmbiguity3D(canvas, {
      height: 410,
      showCallouts: true,
      onHover(hit, ev) {
        if (!hit || !ev) {
          tooltip.classList.remove("is-visible");
          return;
        }
        const amb = finding.ambiguity;
        const lag0 = amb.lag_edges_sec[hit.c];
        const lag1 = amb.lag_edges_sec[hit.c + 1];
        const m0 = amb.mismatch_edges[hit.r].toFixed(1);
        const m1 = amb.mismatch_edges[hit.r + 1].toFixed(1);
        tooltip.innerHTML =
          `<div class="mono">Задержка: ${lag0}–${lag1} с · Смысл 1−cos: ${m0}–${m1}</div>`
          + `<div>Рой: <strong>${hit.sVal}</strong> · Фон: <strong>${hit.bVal}</strong></div>`;
        tooltip.classList.add("is-visible");
        const rect = tooltip.getBoundingClientRect();
        let left = ev.clientX + 12;
        let top = ev.clientY - rect.height - 10;
        if (left + rect.width > window.innerWidth - 8) left = ev.clientX - rect.width - 12;
        if (top < 8) top = ev.clientY + 12;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
      },
    });
    state.viewer3D.setPreset(state.ambPreset);
    state.viewer3D.setFocus(state.focusElement);
    state.viewer3D.update(finding, state.ambMode);

    wrap.querySelectorAll("[data-amb-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.ambMode = btn.dataset.ambMode;
        wrap.querySelectorAll("[data-amb-mode]").forEach((b) => {
          const active = b.dataset.ambMode === state.ambMode;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        state.viewer3D.setMode(state.ambMode);
      });
    });

    wrap.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.ambPreset = btn.dataset.preset;
        wrap.querySelectorAll("[data-preset]").forEach((b) => {
          const active = b.dataset.preset === state.ambPreset;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
        state.viewer3D.setPreset(state.ambPreset);
      });
    });

    wrap.querySelectorAll("[data-focus-el]").forEach((card) => {
      card.addEventListener("click", () => {
        const target = card.dataset.focusEl;
        state.focusElement = state.focusElement === target ? null : target;
        if (state.focusElement === "origin") {
          state.ambPreset = "origin";
          state.viewer3D.setPreset("origin");
        }
        state.viewer3D.setFocus(state.focusElement);
        wrap.querySelectorAll("[data-focus-el]").forEach((c) => {
          const on = c.dataset.focusEl === state.focusElement;
          c.classList.toggle("is-focused", on);
          c.setAttribute("aria-pressed", String(on));
        });
        renderFocusResetButton(wrap);
      });
    });

    renderFocusResetButton(wrap);
  }

  function renderFocusResetButton(wrap) {
    const btn = wrap.querySelector("#clear-focus-btn");
    if (btn) {
      btn.addEventListener("click", () => {
        state.focusElement = null;
        state.viewer3D.setFocus(null);
        renderAmbiguityShowcase(ensureSelection());
      });
    }
  }

  function showToast(text) {
    const toast = document.getElementById("toast");
    toast.textContent = text;
    toast.classList.add("is-visible");
    window.clearTimeout(toast._timer);
    toast._timer = window.setTimeout(() => toast.classList.remove("is-visible"), 3600);
  }

  function bindTopicForm() {
    const form = document.getElementById("topic-form");
    const input = document.getElementById("topic-input");

    document.querySelectorAll("[data-probe-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.probeMode = btn.dataset.probeMode;
        document.querySelectorAll("[data-probe-mode]").forEach((b) => {
          const active = b.dataset.probeMode === state.probeMode;
          b.classList.toggle("is-active", active);
          b.setAttribute("aria-pressed", String(active));
        });
      });
    });

    if (!form) return;
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const query = (input.value || "").trim();
      if (!query) {
        input.focus();
        return;
      }

      const lower = query.toLowerCase();
      const all = sortFindings(state.alerts.findings || []);
      const existing = all.find(
        (f) => f.topic.toLowerCase() === lower || f.topic.toLowerCase().includes(lower)
      );

      if (existing && state.probeMode === "coordinated" && existing.verdict === "coordinated") {
        state.selectedFindingId = existing.id;
        state.focusElement = null;
        render();
        showToast(`Показан найденный кейс по теме «${existing.topic}»`);
        return;
      }

      const { finding, items } = window.LTRMockData.createCustomTopicProbe(query, state.probeMode);
      state.alerts.findings = [finding, ...(state.alerts.findings || [])];
      state.alerts.generated_at = finding.created_at;
      state.alerts.last_poll_at = finding.created_at;
      items.forEach((it) => state.itemsById.set(it.id, it));
      saveInjected(finding, items);

      state.selectedFindingId = finding.id;
      state.focusElement = null;
      render();
      showToast(`Проверена тема «${finding.topic}»: статус обновился`);
    });
  }

  function bindInjectButton() {
    const btn = document.getElementById("inject-btn");
    btn.addEventListener("click", () => {
      if (state.injecting) return;
      state.injecting = true;
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>Запуск роя…</span>`;

      window.setTimeout(() => {
        const input = document.getElementById("topic-input");
        const selected = ensureSelection();
        const topic = (input && input.value.trim()) || (selected && selected.topic) || "helsinki-tram-fares";
        const { finding, items } = window.LTRMockData.createInjectedSwarm(topic);

        state.alerts.findings = [finding, ...(state.alerts.findings || [])];
        state.alerts.generated_at = finding.created_at;
        state.alerts.last_poll_at = finding.created_at;
        items.forEach((it) => state.itemsById.set(it.id, it));
        saveInjected(finding, items);

        state.selectedFindingId = finding.id;
        state.focusElement = "peak";
        state.injecting = false;
        btn.disabled = false;
        btn.innerHTML = `<span>⚡ Вбросить тестовый рой</span>`;
        render();
        showToast(`Тестовый рой вброшен в «${topic}»: SPRT сработал на 5-м посте`);
      }, 650);
    });
  }

  function render() {
    const selected = ensureSelection();
    renderTopMeta();
    renderTopicControls(selected);
    renderCenterSummary(selected);
    renderAmbiguityShowcase(selected);
    syncNavLinks(selected ? selected.id : null);
  }

  bindThemeButtons(() => {
    if (state.viewer3D) state.viewer3D.render();
  });
  bindTopicForm();
  bindInjectButton();
  window.addEventListener("resize", () => {
    if (state.viewer3D) state.viewer3D.render();
  });
  render();
})();
