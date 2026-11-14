/* Live Truth Radar — Shared Reference State & Helpers across all 4 pages */
(function (global) {
  const THEME_KEY = "ltr_ref_theme";
  const INJECTED_KEY = "ltr_ref_injected_v1";

  function resolveInitialTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function applyTheme(theme, onChanged) {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      const isCurrent = btn.dataset.themeChoice === theme;
      btn.classList.toggle("is-active", isCurrent);
      btn.setAttribute("aria-pressed", String(isCurrent));
    });
    if (typeof onChanged === "function") onChanged(theme);
  }

  function bindThemeButtons(onChanged) {
    const initial = resolveInitialTheme();
    applyTheme(initial);
    document.querySelectorAll("[data-theme-choice]").forEach((btn) => {
      btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice, onChanged));
    });
    return initial;
  }

  function loadDataset() {
    const alerts = structuredClone(global.LTRMockData.alertsResponse);
    const items = [...global.LTRMockData.items];

    try {
      const saved = sessionStorage.getItem(INJECTED_KEY);
      if (saved) {
        const extra = JSON.parse(saved);
        if (Array.isArray(extra.findings) && extra.findings.length) {
          alerts.findings = [...extra.findings, ...alerts.findings];
          alerts.generated_at = extra.findings[0].created_at;
          alerts.last_poll_at = extra.findings[0].created_at;
        }
        if (Array.isArray(extra.items)) {
          items.push(...extra.items);
        }
      }
    } catch (_) {
      // Ignore storage errors in restricted environments
    }

    const itemsById = new Map(items.map((item) => [item.id, item]));
    return { alerts, itemsById };
  }

  function saveInjected(finding, items) {
    try {
      const existing = JSON.parse(sessionStorage.getItem(INJECTED_KEY) || '{"findings":[],"items":[]}');
      existing.findings.unshift(finding);
      existing.items.push(...items);
      sessionStorage.setItem(INJECTED_KEY, JSON.stringify(existing));
    } catch (_) {
      // Ignore storage errors
    }
  }

  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function maskHandle(author, isSynthetic, maskEnabled = true) {
    if (!maskEnabled || isSynthetic) return author;
    const clean = String(author).replace(/^@/, "");
    const prefix = clean.slice(0, 2) || "ac";
    return `@${prefix}***`;
  }

  function formatUtcTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(11, 19) + " UTC";
  }

  function formatFreshness(lastPollIso, generatedIso) {
    if (!lastPollIso) return "ожидание поллинга";
    const poll = new Date(lastPollIso).getTime();
    const ref = new Date(generatedIso || Date.now()).getTime();
    const mins = Math.max(0, Math.round((ref - poll) / 60000));
    return `обновлено ${mins} мин назад`;
  }

  function verdictMeta(verdict) {
    if (verdict === "coordinated") {
      return { label: "Coordinated", badgeClass: "verdict-coordinated", icon: "🔴" };
    }
    if (verdict === "watching") {
      return { label: "Keep watching", badgeClass: "verdict-watching", icon: "🟡" };
    }
    return { label: "Organic", badgeClass: "verdict-organic", icon: "🟢" };
  }

  function sortFindings(findings) {
    const rank = { coordinated: 0, watching: 1, organic: 2 };
    return [...findings].sort((a, b) => {
      const ra = rank[a.verdict] ?? 9;
      const rb = rank[b.verdict] ?? 9;
      if (ra !== rb) return ra - rb;
      return new Date(b.created_at) - new Date(a.created_at);
    });
  }

  function syncNavLinks(findingId) {
    const suffix = findingId ? `?id=${encodeURIComponent(findingId)}` : "";
    document.querySelectorAll("[data-nav-keep-id]").forEach((link) => {
      const base = link.getAttribute("data-base-href") || link.getAttribute("href").split("?")[0];
      link.setAttribute("data-base-href", base);
      link.setAttribute("href", base + suffix);
    });
  }

  global.LTRShared = {
    bindThemeButtons,
    loadDataset,
    saveInjected,
    getQueryParam,
    escapeHtml,
    cssVar,
    maskHandle,
    formatUtcTime,
    formatFreshness,
    verdictMeta,
    sortFindings,
    syncNavLinks,
  };
})(window);
