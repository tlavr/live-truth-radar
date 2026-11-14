/* Live Truth Radar — Page #2: Explain-Like-I'm-Five Interactive Walkthrough (5 Steps) */
(function () {
  const {
    bindThemeButtons,
    loadDataset,
    getQueryParam,
    escapeHtml,
    cssVar,
    sortFindings,
    syncNavLinks,
  } = window.LTRShared;

  const data = loadDataset();
  const findings = sortFindings(data.alerts.findings || []);

  const state = {
    selectedId: getQueryParam("id") || (findings[0] && findings[0].id) || null,
    stepIndex: 0, // 0..4
    // Step 1: Flashlight width
    beamThreshold: 0.35,
    // Step 2: Whitening / subtract room noise
    whitened: true,
    // Step 3: Live 3D tower builder
    toySwarmCount: 6,
    toyTightness: 85, // %
    viewer3D: null,
    // Step 4: Stadium goal (News echo) & safety cushion k
    newsJustDropped: false,
    cfarCushion: 2.6,
    // Step 5: Detective scale (SPRT)
    scaleHistory: [0.6, 1.35], // starting slightly above 0
    sprtChart: null,
  };

  function getSelected() {
    return findings.find((f) => f.id === state.selectedId) || findings[0] || null;
  }

  const STEPS = [
    {
      num: "Шаг 1",
      shortTitle: "Фонарик на тему",
      emoji: "🔦",
      headline: "Светим фонариком только на нужную тему",
      kidStory:
        "Представь огромную шумную площадь, где тысячи людей одновременно болтают про погоду, котят, футбол и цены на трамвай. Чтобы не сойти с ума, радар берёт фонарик и светит только на одну тему. Всё, что попало в круг света — изучаем. Всё остальное — оставляем в темноте.",
      takeaway: "Зачем это: случайные шутки или новости про хоккей не мешают считать реальную картину.",
      mathLabel: "Для жюри: Beamforming (косинусное окно Луча)",
      formula: "b_p = clip((⟨e_p, â⟩ − c_lo) / (c_hi − c_lo), 0, 1), старт c_lo=0.15, c_hi=0.35",
    },
    {
      num: "Шаг 2",
      shortTitle: "Тише, общий шум!",
      emoji: "🧭",
      headline: "Вычитаем одинаковые слова, чтобы увидеть шпаргалку",
      kidStory:
        "Если все вокруг спорят про билеты на трамвай, то каждый скажет слово «трамвай» и «цена». Из-за этого кажется, будто все повторяют одно и то же! Мы берём и «стираем» эту общую тему. Обычные люди сразу разбегаются в разные стороны (кто-то хвалит, кто-то шутит, кто-то ругает), а боты с одной шпаргалкой так и остаются стоять вместе!",
      takeaway: "Зачем это: чтобы не спутать 100 обычных пассажиров, упомянувших слово «билет», с армией клонов.",
      mathLabel: "Для жюри: Отбеливание (ортогональная проекция на тему â)",
      formula: "ẽ = norm(e − ⟨e, â⟩ · â) · После вычитания живой фон имеет cos ≈ 0",
    },
    {
      num: "Шаг 3",
      shortTitle: "3D-гора из кубиков",
      emoji: "🧱",
      headline: "Ставим кубики на доску: у ботов вырастает башня!",
      kidStory:
        "Представь шахматную доску. Слева направо — как быстро ответили друг другу (0 секунд слева, 10 минут справа). Вперёд-назад — насколько похож смысл (как близнецы — прямо у переднего края). Каждый раз, когда два аккаунта совпали, кладём туда кубик. Живые люди насыпают низкий ровный коврик, а боты строят в самом ближнем углу красную башню!",
      takeaway: "Зачем 3D: глаз за 1 секунду видит разницу между «ровным ковром» и «небоскрёбом в углу».",
      mathLabel: "Для жюри: 2D-гистограмма неопределённости (|τ| × 1−cos) + экспоненциальный вес",
      formula: "R_ij = max_{|τ| ≤ 10 мин} exp(−|τ|/2 мин) · ⟨ẽ_i, ẽ_j⟩",
    },
    {
      num: "Шаг 4",
      shortTitle: "Гол или боты?",
      emoji: "⚽",
      headline: "Не путаем громкий стадион со скоординированной атакой",
      kidStory:
        "Когда сборная забивает гол на последней минуте, весь стадион кричит «Ура!» в одну секунду. Но это не боты — просто все отреагировали на одно событие! Поэтому радар делает две проверки: сравнивает башню с высотой ковра вокруг и смотрит, не вышла ли за минуту до этого срочная новость.",
      takeaway: "Зачем это: ноль ложных обвинений, когда город бурно обсуждает реальную аварию или новость.",
      mathLabel: "Для жюри: OS-CFAR (адаптивный порог по медиане) + News-Echo Suppression",
      formula: "z_ij = (R_ij − med)/σ_R · Z = Σz_ij/√M · Защита Pfa ≤ 2% + проверка новостей",
    },
    {
      num: "Шаг 5",
      shortTitle: "Весы детектива",
      emoji: "⚖️",
      headline: "Детектив не верит одному посту — он копит гирьки на весах",
      kidStory:
        "Обвинить человека по одному совпадению нельзя — вдруг просто совпало! Наш детектив ставит честные весы. Каждый подозрительный синхронный пост бросает красную гирьку на правую чашу, а обычный независимый спор — зелёную на левую. Как только правая чаша перевесила отметку «Уверены на 98%» — сразу звучит сигнал тревоги!",
      takeaway: "Зачем это: находим рой уже на 5–7-м посте, не дожидаясь конца дня.",
      mathLabel: "Для жюри: Последовательный критерий Вальда (SPRT)",
      formula: "Λ ≥ ln((1−β)/α) ≈ +3.81 → Рой · Λ ≤ ln(β/(1−α)) ≈ −2.28 → Органика",
    },
  ];

  function renderStepperRail() {
    const rail = document.getElementById("stepper-rail");
    rail.innerHTML = STEPS.map((st, idx) => {
      const isActive = idx === state.stepIndex;
      const isDone = idx < state.stepIndex;
      return `
        <button
          type="button"
          class="step-pill ${isActive ? "is-active" : ""} ${isDone ? "is-done" : ""}"
          aria-pressed="${isActive}"
          data-step-idx="${idx}"
        >
          <div class="step-pill-num">${st.emoji} ${st.num}</div>
          <div class="step-pill-title">${escapeHtml(st.shortTitle)}</div>
        </button>
      `;
    }).join("");

    rail.querySelectorAll("[data-step-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.stepIndex = Number(btn.dataset.stepIdx);
        renderStage();
      });
    });
  }

  /* ---------- Interactive Toy 1: Flashlight Beam ---------- */
  const SAMPLE_BEAM_POSTS = [
    { author: "@anna_hki", text: "Опять подняли тариф на трамвай на 15%, хотя отопление в старых вагонах еле работает.", sim: 0.78, tag: "Прямо в тему" },
    { author: "@mikko_transit", text: "Новый проездной стал дороже для студентов со следующей недели.", sim: 0.56, tag: "По теме" },
    { author: "@city_runner", text: "На набережной сегодня шикарный рассвет, успел пробежать 8 км до трамвая!", sim: 0.24, tag: "На краю луча" },
    { author: "@hockey_fan99", text: "Наши вчера забили три шайбы в большинстве — стадион просто взорвался!", sim: 0.08, tag: "Другая тема (шум)" },
  ];

  function bindStep1(mount) {
    function draw() {
      const thr = state.beamThreshold;
      const coneHalfAngle = 14 + (1 - thr) * 34; // wider when threshold is lower
      const inLightCount = SAMPLE_BEAM_POSTS.filter((p) => p.sim >= thr).length;

      mount.innerHTML = `
        <div class="toy-card">
          <div class="toy-header">
            <div>
              <span class="toy-badge">Игрушка 1 · Покрути фонарик</span>
              <h3 class="toy-title">Какие посты попадут в луч «Тарифы на трамвай»?</h3>
            </div>
            <span class="toy-counter num">Попало: ${inLightCount} из ${SAMPLE_BEAM_POSTS.length}</span>
          </div>

          <div class="flashlight-stage" aria-hidden="true">
            <svg viewBox="0 0 360 110" class="flashlight-svg">
              <defs>
                <linearGradient id="beamGrad" x1="0%" y1="50%" x2="100%" y2="50%">
                  <stop offset="0%" stop-color="rgba(255, 204, 0, 0.55)" />
                  <stop offset="100%" stop-color="rgba(255, 204, 0, 0.04)" />
                </linearGradient>
              </defs>
              <rect x="14" y="42" width="38" height="26" rx="6" fill="currentColor" opacity="0.75" />
              <polygon points="52,44 350,${Math.max(4, 55 - coneHalfAngle)} 350,${Math.min(106, 55 + coneHalfAngle)} 52,66" fill="url(#beamGrad)" />
              <text x="195" y="59" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">
                Порог света: ${Math.round(thr * 100)}% сходства
              </text>
            </svg>
          </div>

          <div class="slider-box">
            <div class="slider-head">
              <label for="toy-beam-slider">Строгость отбора (выше = луч уже)</label>
              <strong class="num">${Math.round(thr * 100)}%</strong>
            </div>
            <input id="toy-beam-slider" type="range" min="0.05" max="0.75" step="0.05" value="${thr}" />
            <div class="slider-hints">
              <span>Широкий луч (проходит всё)</span>
              <span>Узкий луч (только про тарифы)</span>
            </div>
          </div>

          <div class="toy-posts-list">
            ${SAMPLE_BEAM_POSTS.map((p) => {
              const lit = p.sim >= thr;
              return `
                <div class="toy-post ${lit ? "is-lit" : "is-dim"}">
                  <div class="toy-post-top">
                    <span class="mono">${escapeHtml(p.author)}</span>
                    <span class="toy-post-status ${lit ? "status-in" : "status-out"}">
                      ${lit ? "💡 В круге света" : "🌑 Отфильтровано"} (${Math.round(p.sim * 100)}%)
                    </span>
                  </div>
                  <div class="toy-post-text">${escapeHtml(p.text)}</div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;

      const slider = mount.querySelector("#toy-beam-slider");
      slider.addEventListener("input", (ev) => {
        state.beamThreshold = Number(ev.target.value);
        draw();
        const fresh = mount.querySelector("#toy-beam-slider");
        if (fresh) fresh.focus();
      });
    }
    draw();
  }

  /* ---------- Interactive Toy 2: Meaning Compass (Whitening) ---------- */
  function bindStep2(mount) {
    function draw() {
      const clean = state.whitened;
      // Angles in degrees (0 = up / 12 o'clock)
      const peopleAngles = clean ? [-125, -62, 48, 118, 165] : [-22, -11, 8, 18, 29];
      const botAngles = clean ? [-4, 2, -2, 5] : [-7, -3, 1, 4];

      function arrowCoords(deg, len) {
        const rad = ((deg - 90) * Math.PI) / 180;
        return {
          x: (140 + Math.cos(rad) * len).toFixed(1),
          y: (130 + Math.sin(rad) * len).toFixed(1),
        };
      }

      const avgLivingCos = clean ? "0.06 (совсем разные!)" : "0.74 (похожи из-за слова «трамвай»)";
      const avgBotCos = clean ? "0.93 (всё ещё под копирку!)" : "0.96 (под копирку)";

      mount.innerHTML = `
        <div class="toy-card">
          <div class="toy-header">
            <div>
              <span class="toy-badge">Игрушка 2 · Компас смысла</span>
              <h3 class="toy-title">Что происходит со стрелками людей и ботов?</h3>
            </div>
            <button
              type="button"
              id="toy-whiten-btn"
              class="btn ${clean ? "btn-primary" : "btn-secondary"}"
              aria-pressed="${clean}"
            >
              ${clean ? "✓ Шум темы вычтен" : "Включить очистку шума"}
            </button>
          </div>

          <div class="compass-wrap">
            <svg viewBox="0 0 280 260" class="compass-svg" role="img" aria-label="Компас направлений смысла постов людей и ботов">
              <circle cx="140" cy="130" r="96" fill="none" stroke="currentColor" stroke-opacity="0.16" stroke-dasharray="4 4" />
              <circle cx="140" cy="130" r="48" fill="none" stroke="currentColor" stroke-opacity="0.1" />
              <line x1="140" y1="22" x2="140" y2="238" stroke="currentColor" stroke-opacity="0.12" />
              <line x1="32" y1="130" x2="248" y2="130" stroke="currentColor" stroke-opacity="0.12" />

              <text x="140" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor" opacity="0.65">
                Общая тема «трамвай» (вверх)
              </text>

              ${peopleAngles.map((deg) => {
                const pt = arrowCoords(deg, 78);
                return `<line x1="140" y1="130" x2="${pt.x}" y2="${pt.y}" stroke="#007aff" stroke-width="3" stroke-linecap="round" opacity="0.8" />
                        <circle cx="${pt.x}" cy="${pt.y}" r="4.5" fill="#007aff" />`;
              }).join("")}

              ${botAngles.map((deg) => {
                const pt = arrowCoords(deg, 92);
                return `<line x1="140" y1="130" x2="${pt.x}" y2="${pt.y}" stroke="#ff3b30" stroke-width="3.5" stroke-linecap="round" />
                        <circle cx="${pt.x}" cy="${pt.y}" r="5" fill="#ff3b30" />`;
              }).join("")}

              <circle cx="140" cy="130" r="7" fill="currentColor" />
            </svg>

            <div class="compass-legend">
              <div class="compass-stat-card tone-blue">
                <strong>🔵 Обычные люди (5 стрелок)</strong>
                <div class="num">${avgLivingCos}</div>
                <p>${clean ? "Разлетелись по всему кругу — у каждого своё мнение!" : "Сбились в кучу наверху просто из-за общих слов о транспорте."}</p>
              </div>
              <div class="compass-stat-card tone-red">
                <strong>🔴 Боты со шпаргалкой (4 стрелки)</strong>
                <div class="num">${avgBotCos}</div>
                <p>${clean ? "Даже без общих слов стрелки склеены! Радар поймал сговор." : "Тонут в общей куче — пока трудно отличить от толпы."}</p>
              </div>
            </div>
          </div>
        </div>
      `;

      mount.querySelector("#toy-whiten-btn").addEventListener("click", () => {
        state.whitened = !state.whitened;
        draw();
      });
    }
    draw();
  }

  /* ---------- Interactive Toy 3: 3D Lego Tower Builder ---------- */
  function bindStep3(mount, baseFinding) {
    mount.innerHTML = `
      <div class="toy-card">
        <div class="toy-header">
          <div>
            <span class="toy-badge">Игрушка 3 · Строим 3D-гору сами</span>
            <h3 class="toy-title">Покрути размер роя и посмотри, как растёт башня!</h3>
          </div>
          <span id="toy3-pairs-badge" class="toy-counter num"></span>
        </div>

        <div class="sliders-two">
          <div class="slider-box">
            <div class="slider-head">
              <label for="toy-swarm-n">Сколько ботов в группе</label>
              <strong id="toy3-n-val" class="num">${state.toySwarmCount} шт.</strong>
            </div>
            <input id="toy-swarm-n" type="range" min="2" max="12" step="1" value="${state.toySwarmCount}" />
          </div>

          <div class="slider-box">
            <div class="slider-head">
              <label for="toy-tight-val">Насколько дружно бьют</label>
              <strong id="toy3-tight-label" class="num">${state.toyTightness}%</strong>
            </div>
            <input id="toy-tight-val" type="range" min="25" max="100" step="5" value="${state.toyTightness}" />
          </div>
        </div>

        <div class="canvas-3d-wrap" style="min-height: 310px;">
          <canvas id="how-3d-canvas" class="canvas-3d" style="height: 310px;"></canvas>
        </div>
      </div>
    `;

    const canvas = mount.querySelector("#how-3d-canvas");
    state.viewer3D = window.LTRAmbiguity3D.createAmbiguity3D(canvas, {
      height: 310,
      showCallouts: true,
    });

    function updateScene() {
      const n = state.toySwarmCount;
      const tight = state.toyTightness / 100;
      const pairs = (n * (n - 1)) / 2;

      const badge = mount.querySelector("#toy3-pairs-badge");
      const nLabel = mount.querySelector("#toy3-n-val");
      const tLabel = mount.querySelector("#toy3-tight-label");
      if (badge) badge.textContent = `${pairs} пар совпадений`;
      if (nLabel) nLabel.textContent = `${n} шт.`;
      if (tLabel) tLabel.textContent = `${Math.round(tight * 100)}%`;

      const counts = Array.from({ length: 10 }, () => Array(20).fill(0));
      const peakBin = Math.max(1, Math.round(pairs * tight * 0.55));
      const neighbor = Math.max(0, Math.round(pairs * (1 - tight * 0.65) * 0.35));
      counts[0][0] = peakBin;
      counts[0][1] = Math.round(peakBin * 0.55);
      counts[1][0] = Math.round(peakBin * 0.35);
      counts[1][2] = neighbor;
      counts[2][3] = Math.max(0, Math.round((1 - tight) * 4));

      const template = JSON.parse(JSON.stringify(baseFinding));
      template.verdict = n >= 5 && tight >= 0.6 ? "coordinated" : n >= 4 ? "watching" : "organic";
      template.note = null;
      template.ambiguity.counts = counts;

      state.viewer3D.update(template, "combined");
    }

    mount.querySelector("#toy-swarm-n").addEventListener("input", (ev) => {
      state.toySwarmCount = Number(ev.target.value);
      updateScene();
    });

    mount.querySelector("#toy-tight-val").addEventListener("input", (ev) => {
      state.toyTightness = Number(ev.target.value);
      updateScene();
    });

    updateScene();
  }

  /* ---------- Interactive Toy 4: Stadium Goal (CFAR + News Echo) ---------- */
  function bindStep4(mount) {
    function draw() {
      const isEcho = state.newsJustDropped;
      const k = state.cfarCushion;
      const bgNoise = isEcho ? 34 : 14;
      const spikeHeight = isEcho ? 58 : 74;
      const adaptiveThreshold = Math.round(bgNoise * k);
      const alarms = !isEcho && spikeHeight > adaptiveThreshold;

      mount.innerHTML = `
        <div class="toy-card">
          <div class="toy-header">
            <div>
              <span class="toy-badge">Игрушка 4 · Защита от ложных тревог</span>
              <h3 class="toy-title">Проверь, как радар отличает новость от ботов</h3>
            </div>
            <button
              type="button"
              id="toy-news-btn"
              class="btn ${isEcho ? "btn-primary" : "btn-secondary"}"
              aria-pressed="${isEcho}"
            >
              ${isEcho ? "📰 Срочная новость включена!" : "⚡ Включить «Срочную новость»"}
            </button>
          </div>

          <div class="cfar-bars">
            <div class="cfar-bar-col">
              <div class="cfar-bar-track">
                <div class="cfar-bar-fill bar-blue" style="height:${bgNoise}%"></div>
              </div>
              <strong class="num">${bgNoise}</strong>
              <span>Фон вокруг (ковер)</span>
            </div>

            <div class="cfar-bar-col">
              <div class="cfar-bar-track">
                <div class="cfar-threshold-line" style="bottom:${Math.min(98, adaptiveThreshold)}%">
                  <span class="num">Планка: ${adaptiveThreshold}</span>
                </div>
                <div class="cfar-bar-fill ${alarms ? "bar-red" : "bar-amber"}" style="height:${spikeHeight}%"></div>
              </div>
              <strong class="num">${spikeHeight}</strong>
              <span>Пик в углу</span>
            </div>
          </div>

          <div class="slider-box">
            <div class="slider-head">
              <label for="toy-cfar-k">Запас осторожности (во сколько раз пик должен быть выше фона)</label>
              <strong class="num">×${k.toFixed(1)}</strong>
            </div>
            <input id="toy-cfar-k" type="range" min="1.4" max="3.8" step="0.2" value="${k}" />
          </div>

          <div class="cfar-verdict ${alarms ? "is-alarm" : isEcho ? "is-echo" : "is-safe"}">
            ${alarms
              ? `<strong>🔴 Сработала тревога!</strong> Пик (${spikeHeight}) пробил адаптивную планку (${adaptiveThreshold}), и новостей перед этим не было.`
              : isEcho
                ? `<strong>🟡 Ложной тревоги нет!</strong> Все обсуждают свежую новость — общий фон вырос, и планка (${adaptiveThreshold}) поднялась вместе с ним.`
                : `<strong>🟢 Тревога не нужна.</strong> Пик (${spikeHeight}) не дотянул до осторожной планки (${adaptiveThreshold}).`
            }
          </div>
        </div>
      `;

      mount.querySelector("#toy-news-btn").addEventListener("click", () => {
        state.newsJustDropped = !state.newsJustDropped;
        draw();
      });
      mount.querySelector("#toy-cfar-k").addEventListener("input", (ev) => {
        state.cfarCushion = Number(ev.target.value);
        draw();
        const fresh = mount.querySelector("#toy-cfar-k");
        if (fresh) fresh.focus();
      });
    }
    draw();
  }

  /* ---------- Interactive Toy 5: Detective Balance Scale (SPRT) ---------- */
  function bindStep5(mount) {
    function draw() {
      const upper = 3.81;
      const lower = -2.28;
      const current = state.scaleHistory[state.scaleHistory.length - 1] || 0;
      const pct = Math.max(0, Math.min(100, ((current - lower) / (upper - lower)) * 100));
      const decidedSwarm = current >= upper;
      const decidedOrg = current <= lower;
      const tiltDeg = Math.max(-14, Math.min(14, (current / upper) * 14));

      mount.innerHTML = `
        <div class="toy-card">
          <div class="toy-header">
            <div>
              <span class="toy-badge">Игрушка 5 · Весы детектива</span>
              <h3 class="toy-title">Добавляй новые посты и смотри, когда чаша перевесит</h3>
            </div>
            <span class="toy-counter num">Постов: ${state.scaleHistory.length}</span>
          </div>

          <div class="scale-visual" aria-hidden="true">
            <div class="scale-beam" style="transform: rotate(${tiltDeg.toFixed(1)}deg);">
              <div class="scale-pan pan-left">🟢 Живой спор</div>
              <div class="scale-pan pan-right">🔴 Подозрение в рое</div>
            </div>
            <div class="scale-fulcrum"></div>
          </div>

          <div class="meter-bar-wrap">
            <div class="meter-labels">
              <span class="meter-left">🟢 Живые люди (${lower.toFixed(1)})</span>
              <strong class="num">Сейчас: ${current >= 0 ? "+" : ""}${current.toFixed(2)}</strong>
              <span class="meter-right">🔴 Доказано: рой! (+${upper.toFixed(1)})</span>
            </div>
            <div class="meter-track">
              <div class="meter-fill ${decidedSwarm ? "fill-red" : decidedOrg ? "fill-green" : "fill-accent"}" style="width:${pct.toFixed(1)}%"></div>
            </div>
          </div>

          <div class="scale-status-banner ${decidedSwarm ? "is-alarm" : decidedOrg ? "is-safe" : "is-wait"}">
            ${decidedSwarm
              ? "🎉 Улики собраны! Стрелка пересекла +3.81 — включаем сигнал с уверенностью 98%."
              : decidedOrg
                ? "✅ Весы упали влево (-2.28) — это точно живая беседа, закрываем дело."
                : "⏳ Пока данных мало — нажимай кнопки ниже, чтобы подкинуть новый пост на весы."}
          </div>

          <div class="toy-btn-row">
            <button type="button" id="add-bot-post" class="btn btn-primary" ${decidedSwarm || decidedOrg ? "disabled" : ""}>
              +1 синхронный пост (бот)
            </button>
            <button type="button" id="add-human-post" class="btn btn-secondary" ${decidedSwarm || decidedOrg ? "disabled" : ""}>
              +1 обычный пост (человек)
            </button>
            <button type="button" id="reset-scale" class="btn btn-ghost">Сбросить</button>
          </div>

          <div class="chart-box" style="height: 185px; margin-top: 12px;">
            <canvas id="how-sprt-canvas"></canvas>
          </div>
        </div>
      `;

      mount.querySelector("#add-bot-post").addEventListener("click", () => {
        const last = state.scaleHistory[state.scaleHistory.length - 1] || 0;
        state.scaleHistory.push(Number(Math.min(4.6, last + 0.72).toFixed(2)));
        draw();
      });

      mount.querySelector("#add-human-post").addEventListener("click", () => {
        const last = state.scaleHistory[state.scaleHistory.length - 1] || 0;
        state.scaleHistory.push(Number(Math.max(-2.7, last - 0.68).toFixed(2)));
        draw();
      });

      mount.querySelector("#reset-scale").addEventListener("click", () => {
        state.scaleHistory = [0.6, 1.35];
        draw();
      });

      // Render lightweight Chart.js trace
      const ctx = mount.querySelector("#how-sprt-canvas");
      if (state.sprtChart && typeof state.sprtChart.destroy === "function") {
        state.sprtChart.destroy();
      }
      if (typeof Chart === "function" && ctx) {
        const len = Math.max(8, state.scaleHistory.length);
        const labels = Array.from({ length: len }, (_, i) => `#${i + 1}`);
        state.sprtChart = new Chart(ctx, {
          type: "line",
          data: {
            labels,
            datasets: [
              {
                label: "Вес улик (Λ)",
                data: state.scaleHistory,
                borderColor: cssVar("--accent") || "#007aff",
                backgroundColor: cssVar("--accent-tint") || "rgba(0,122,255,0.12)",
                fill: true,
                tension: 0.25,
                pointRadius: 4,
              },
              {
                label: "Порог Рой (+3.81)",
                data: Array(len).fill(upper),
                borderColor: cssVar("--red") || "#ff3b30",
                borderDash: [5, 4],
                pointRadius: 0,
              },
              {
                label: "Порог Органика (-2.28)",
                data: Array(len).fill(lower),
                borderColor: cssVar("--green") || "#34c759",
                borderDash: [5, 4],
                pointRadius: 0,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
              legend: { display: false },
            },
            scales: {
              y: {
                min: -3,
                max: 4.8,
                grid: { color: cssVar("--chart-grid") || "rgba(0,0,0,0.08)" },
                ticks: { color: cssVar("--text-secondary") || "#59595e" },
              },
              x: {
                grid: { display: false },
                ticks: { color: cssVar("--text-secondary") || "#59595e" },
              },
            },
          },
        });
      }
    }
    draw();
  }

  function renderStage() {
    renderStepperRail();
    const st = STEPS[state.stepIndex];
    const selected = getSelected();
    const idParam = selected ? `?id=${encodeURIComponent(selected.id)}` : "";
    const stage = document.getElementById("guideline-stage");

    stage.innerHTML = `
      <div class="kid-explain-col">
        <div class="step-badge-row">
          <span class="step-badge-num">${st.emoji} ${st.num} из 5</span>
        </div>
        <h2 class="step-headline">${escapeHtml(st.headline)}</h2>
        <p class="kid-story">${escapeHtml(st.kidStory)}</p>

        <div class="takeaway-box">
          <strong>Коротко:</strong> ${escapeHtml(st.takeaway)}
        </div>

        <details class="math-drawer">
          <summary>🤓 ${escapeHtml(st.mathLabel)}</summary>
          <div class="formula-box">${escapeHtml(st.formula)}</div>
        </details>

        <div class="step-nav-footer">
          <button type="button" id="prev-step-btn" class="btn btn-secondary" ${state.stepIndex === 0 ? "disabled" : ""}>
            ‹ Назад
          </button>
          ${state.stepIndex < STEPS.length - 1
            ? `<button type="button" id="next-step-btn" class="btn btn-primary">Дальше: ${escapeHtml(STEPS[state.stepIndex + 1].shortTitle)} ›</button>`
            : `<a class="btn btn-primary" href="index.html${idParam}">Проверить свою тему на радаре ›</a>`
          }
        </div>
      </div>

      <div id="toy-mount" class="toy-mount"></div>
    `;

    stage.querySelector("#prev-step-btn").addEventListener("click", () => {
      if (state.stepIndex > 0) {
        state.stepIndex -= 1;
        renderStage();
      }
    });
    const nextBtn = stage.querySelector("#next-step-btn");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (state.stepIndex < STEPS.length - 1) {
          state.stepIndex += 1;
          renderStage();
        }
      });
    }

    const mount = document.getElementById("toy-mount");
    if (state.stepIndex === 0) bindStep1(mount);
    else if (state.stepIndex === 1) bindStep2(mount);
    else if (state.stepIndex === 2) bindStep3(mount, selected);
    else if (state.stepIndex === 3) bindStep4(mount);
    else bindStep5(mount);

    syncNavLinks(selected ? selected.id : null);
  }

  bindThemeButtons(() => renderStage());
  window.addEventListener("resize", () => {
    if (state.stepIndex === 2 && state.viewer3D) state.viewer3D.render();
  });
  renderStage();
})();
