import {
  TRANSITION_STYLES,
  isDesktopMotion,
  desktopMask,
  desktopTransform,
} from '../shared/desktop-motion.js';
import art2 from '../../assets/bio/bio-image-2.webp';
import art1 from '../../assets/bio/bio-image-1.webp';
import translations from './translations.json';
import demos from './demos.json';

(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const sessionPreferences = new Map();
  const storage = {
    get(key, fallback) {
      if (sessionPreferences.has(key)) return sessionPreferences.get(key);
      try {
        const legacy = { particles: 'fx', liquid: 'liq' }[key] || key;
        return localStorage.getItem('bio.' + key) ?? localStorage.getItem('ab_' + legacy) ?? fallback;
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      sessionPreferences.set(key, String(value));
      try {
        localStorage.setItem('bio.' + key, value);
      } catch (_) {
        /* Private browsing / file:// still works. */
      }
    },
  };
  const state = { view: 'home', motion: !reduced.matches && storage.get('motion', 'on') !== 'off' };
  const preferences = {
    lang: storage.get('lang', 'ru') === 'en' ? 'en' : 'ru',
    background: ['constellation', 'aurora', 'plain'].includes(storage.get('background'))
      ? storage.get('background')
      : 'constellation',
    transition: ['mix', ...TRANSITION_STYLES].includes(storage.get('transition'))
      ? storage.get('transition')
      : 'hyprland',
  };
  for (const key of ['ripple', 'particles', 'liquid', 'glass'])
    preferences[key] = !['off', 'false', false].includes(storage.get(key, 'on'));
  let renderer = null;
  const arrow = '<svg class="icon" aria-hidden="true"><use href="#i-arrow"/></svg>';
  const escapeHTML = (text) =>
    String(text).replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );

  // Real destinations from index.html. No simulated purchases, messages or API calls.
  const projects = {
    xli: {
      title: 'XLI Ecosystem',
      label: '01 / AI ECOSYSTEM · В РАЗРАБОТКЕ',
      intro:
        'Экосистема на Go вокруг XGO Agent: бот, плагин для Nvim и своя терминальная среда. Один агент — в привычном тебе интерфейсе.',
      tags: ['Go', 'XGO Agent', 'Nvim', 'CLI'],
      features: [
        'XGO Agent — ядро экосистемы и работа с инструментами.',
        'XLI Bot — Telegram-интерфейс к агенту.',
        'XLI Nvim Plugin — помощь прямо в редакторе.',
        'XLI CLI — терминальный интерфейс и система плагинов XPI.',
      ],
      terminal: true,
      url: 'https://t.me/Aubeig',
      action: 'Узнать о проекте',
      note: 'В разработке.',
    },
    anonshare: {
      title: 'AnonShare',
      label: '02 / CLAWBACK RELEASE',
      intro:
        'Приватная P2P-передача файлов через WebRTC. Сервер знакомит два браузера, а сами файлы передаются по защищённому каналу между участниками.',
      tags: ['WebRTC', 'AES-GCM', 'P2P', 'Без регистрации'],
      features: [
        'Шифрование AES-GCM на клиенте до отправки.',
        'Секрет в части ссылки после # не отправляется серверу.',
        'Сигналинг-сервер управляет комнатой, но не хранит файлы.',
        'Временные комнаты, без аккаунтов и постоянного хранилища.',
        'STUN / TURN для соединения за NAT; TURN может ретранслировать зашифрованный трафик.',
      ],
      image: art2,
      url: 'https://anonshare-tau.vercel.app/',
      action: 'Открыть AnonShare',
      note: 'Передавай файлы только доверенному получателю и не публикуй секретную ссылку комнаты.',
    },
    xgo: {
      title: 'XGO Bot',
      label: '03 / TELEGRAM AI · В РАЗРАБОТКЕ',
      intro:
        'Telegram AI-ассистент на aiogram с пошаговым агентным циклом. Подбирает инструменты, выполняет несколько шагов и показывает понятную структуру работы.',
      tags: ['Python', 'Aiogram', 'AI Agent'],
      features: [
        '10 инструментов: веб-поиск, выполнение кода, таблицы, графики, презентации и файлы.',
        'Интеграция с GitHub: чтение, коммиты и Actions.',
        'Сжатие истории диалога для работы с длинным контекстом.',
        'Мультипровайдерный fallback для устойчивости.',
      ],
      url: 'https://t.me/Aubeig',
      action: 'Узнать о XGO Bot',
      note: 'В разработке.',
    },
    hydra: {
      title: 'Hydra User Bot',
      label: '04 / CLOSED BETA 1.2.0',
      intro: 'Юзербот для Telegram с расширяемой архитектурой, асинхронным ядром и акцентом на скорость.',
      tags: ['Telegram', 'Plugins', 'Async'],
      features: [
        'Система плагинов для расширения возможностей.',
        'Антиспам-защита и автоматизация привычных задач.',
        'Асинхронное ядро для быстрой обработки событий.',
        'Модуль HtmlHelper доступен в магазине.',
      ],
      url: 'https://t.me/Aubeig',
      action: 'Уточнить доступ к бете',
      note: 'Доступ к закрытой бете — в Telegram.',
    },
    anon: {
      title: 'Anon Bot',
      label: '05 / ЗАКРЫТОЕ БЕТА',
      intro:
        'Инструменты для Telegram-каналов и личного использования. Голосовые сообщения и кружки превращаются в текст, а длинные расшифровки — в краткое содержание.',
      tags: ['Telegram', 'Voice → Text', 'ЗБТ'],
      features: [
        'Расшифровка голосовых сообщений.',
        'Расшифровка видеокружков.',
        'Сжатие расшифровки до главных мыслей.',
        'Для Telegram-каналов и личного использования.',
      ],
      url: 'https://t.me/Aubeig',
      action: 'Узнать о ЗБТ',
      note: 'Закрытое бета-тестирование. Доступ и актуальные возможности — в личных сообщениях.',
    },
    development: {
      title: 'Твоя следующая идея',
      label: '06 / DEVELOPMENT',
      intro:
        'Разработка веб-сайтов, Telegram-ботов, парсеров и утилит под задачу. От первого прототипа до законченного цифрового продукта.',
      tags: ['Python', 'Aiogram / Pyrogram', 'HTML / CSS / JS'],
      features: [
        'Веб-сайты с индивидуальным дизайном и адаптивной вёрсткой.',
        'Telegram-боты и автоматизация рабочих процессов.',
        'Парсеры, небольшие утилиты и интеграции.',
        'Возможность обсудить исходный код прошлой версии сайта.',
      ],
      url: 'https://t.me/Aubeig',
      action: 'Обсудить задачу',
      note: 'Стоимость и сроки обсуждаются после знакомства с задачей.',
    },
    firstplatform: {
      title: 'First Platform',
      label: 'COMMUNITY / ПАРТНЁРЫ',
      intro:
        'Сообщество ZFliers для блогеров, стримеров и авторов каналов. Здесь можно найти единомышленников, партнёров по съёмкам и поделиться своим проектом.',
      tags: ['Creators', 'YouTube', 'Telegram', 'Twitch'],
      features: [
        'Идеи и общение с другими участниками.',
        'Возможность рассказать о своём канале.',
        'Администрация: @Vpkino, @MIHAILBAIKXCO, @Sofie_Fie.',
        'Вопросы по рекламе: @ZF_LIERS; другие вопросы — модерации.',
      ],
      url: 'https://t.me/ZFliers',
      action: 'Перейти к First Platform',
      note: 'Администрация помогает по возможности. Условия участия уточняй у команды сообщества.',
    },
    clawback: {
      title: 'ClawBack',
      label: 'INTELLIGENCE DIVISION / 2026',
      intro:
        'Hacktivists and system reclaimers. Децентрализованный коллектив, объединённый идеей свободы информации и прозрачности.',
      tags: ['Data liberation', 'Decentralized', 'AnonShare'],
      image: art1,
      features: [
        'Аморфный, децентрализованный коллектив без центрального командования.',
        'Открытость информации и противодействие системной несправедливости.',
        'AnonShare — проект приватной передачи файлов.',
      ],
      url: 'https://anonshare-tau.vercel.app/',
      action: 'Открыть проект AnonShare',
      note: 'WE TAKE IT ALL BACK. Авторство исходного сайта: ClawBack Intelligence Division, CPL v1.0.',
    },
  };

  const DEMO_DATA = demos;
  let ORIGINAL_DEMOS = DEMO_DATA[preferences.lang];
  const UI_MODES = {
    headless: {
      title: 'HeadlessUI',
      tag: 'headless.py',
      description:
        'Безоконный режим для CI/CD и скриптов: задача из аргумента командной строки, без интерактива. Поддерживает многошаговое делегирование через TaskTool.',
      features: [
        'TaskTool: @coder, @tester, @debugger, @optimizer, @reviewer',
        'Обычная цепочка агентов через XliCore.run_chain',
        'Вывод text / json / vim; max_steps = 15 на агента',
      ],
    },
    tui: {
      title: 'XliTui',
      tag: 'tui.py · Textual',
      description:
        'Полноценная TUI на Textual: живая сетка из пяти агентов, прогресс-бары, статусы, лог активности и ввод задачи в одном экране.',
      features: [
        'Сетка 3×N: CODER · DEBUGGER · TESTER · OPTIMIZER · REVIEWER',
        'Живой прогресс и статус каждого агента',
        'c — очистить, f — ввод, m — MCP, q — skip questions, s — стриминг; MCP-счётчик в шапке',
      ],
    },
    nvim: {
      title: 'NvimQuestionnaire',
      tag: 'nvim.py · questionnaire.lua',
      description:
        'Уточняющие вопросы агента появляются прямо в Neovim. Контекст редактора не теряется: выбор решения, правка и diff остаются рядом с кодом.',
      features: [
        'Вопросы с вариантами через vim.ui.select',
        'Свободный текстовый ввод через vim.ui.input',
        'Автоматический fallback в Terminal-режим, если Neovim недоступен',
      ],
    },
    terminal: {
      title: 'TerminalQuestionnaire',
      tag: 'terminal.py · input()',
      description:
        'Простой универсальный режим уточнения задачи через стандартный input(). Без внешних UI-зависимостей; базовый fallback для остальных интерфейсов.',
      features: [
        'Варианты ответа и валидация выбора',
        'Значения по умолчанию для необязательных полей',
        'Retry-стратегия, логирование, правка кода и тесты',
      ],
    },
  };
  const icons = (name) => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeOut = (t) => 1 - Math.pow(1 - t, 4);

  // All paths have the same 12 cubic segments: they can actually interpolate.
  function materialPath(x, y, w, h, r = 28, warp = 0) {
    r = Math.min(r, w * 0.46, h * 0.46);
    const points = [
      [x + r, y],
      [x + w * 0.5, y + h * 0.07 * warp],
      [x + w - r, y],
      [x + w, y + r],
      [x + w - w * 0.065 * warp, y + h * 0.52],
      [x + w, y + h - r],
      [x + w - r, y + h],
      [x + w * 0.5, y + h - h * 0.075 * warp],
      [x + r, y + h],
      [x, y + h - r],
      [x + w * 0.06 * warp, y + h * 0.46],
      [x, y + r],
    ];
    const n = points.length,
      fmt = (v) => v.toFixed(2);
    let d = 'M ' + points[0].map(fmt).join(' ');
    for (let i = 0; i < n; i++) {
      const a = points[(i + n - 1) % n],
        b = points[i],
        c = points[(i + 1) % n],
        e = points[(i + 2) % n];
      const c1 = [clamp(b[0] + (c[0] - a[0]) * 0.14, x, x + w), clamp(b[1] + (c[1] - a[1]) * 0.14, y, y + h)];
      const c2 = [clamp(c[0] - (e[0] - b[0]) * 0.14, x, x + w), clamp(c[1] - (e[1] - b[1]) * 0.14, y, y + h)];
      d += ' C ' + [...c1, ...c2, ...c].map(fmt).join(' ');
    }
    return d + ' Z';
  }
  const cssPath = (d) => 'path("' + d + '")';
  function revealPaths(w, h, origin = 0.25) {
    const y = clamp(Math.min(h * origin, 140) - 35, 0, Math.max(0, h - 70));
    return {
      full: cssPath(materialPath(0, 0, w, h, 27, 0)),
      fold: cssPath(materialPath(0, h * 0.018, w * 0.77, h * 0.96, Math.min(64, h * 0.2), 0.95)),
      seed: cssPath(materialPath(0, y, Math.min(62, w), Math.min(72, h), 32, 0.15)),
    };
  }
  const regionMotions = new WeakMap();
  function morphRegion(element, change, { duration = 500 } = {}) {
    if (!element) return;
    const prior = regionMotions.get(element);
    prior?.animations.forEach((a) => a.cancel());
    const before = element.getBoundingClientRect();
    element.style.removeProperty('height');
    element.style.removeProperty('overflow');
    change?.();
    if (!state.motion || !element.getClientRects().length) return;
    const after = element.getBoundingClientRect();
    if (!after.width || !after.height) return;
    const record = { animations: [] };
    regionMotions.set(element, record);
    const paths = revealPaths(after.width, after.height, 0.24);
    const clip = element.animate(
      [
        { clipPath: paths.seed },
        { clipPath: cssPath(materialPath(0, 0, after.width, after.height, 42, 0.7)), offset: 0.63 },
        { clipPath: paths.full },
      ],
      { duration, easing: 'cubic-bezier(.2,.8,.25,1)' },
    );
    record.animations.push(clip);
    if (Math.abs(before.height - after.height) > 2 && before.height > 0) {
      element.style.overflow = 'hidden';
      record.animations.push(
        element.animate([{ height: before.height + 'px' }, { height: after.height + 'px' }], {
          duration,
          easing: 'cubic-bezier(.22,1,.36,1)',
        }),
      );
    }
    Promise.allSettled(record.animations.map((a) => a.finished)).then(() => {
      if (regionMotions.get(element) === record) {
        element.style.removeProperty('height');
        element.style.removeProperty('overflow');
        regionMotions.delete(element);
      }
    });
  }
  function popMessage(element, instant = false) {
    if (!state.motion || instant) return;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const fromRight = element.classList.contains('from-user');
    const x = fromRight ? Math.max(0, box.width - 32) : 0;
    element.animate(
      [
        {
          clipPath: cssPath(materialPath(x, box.height * 0.3, 32, Math.min(34, box.height), 15, 0.1)),
          transform: 'translateY(6px)',
        },
        {
          clipPath: cssPath(materialPath(0, 0, box.width, box.height, 25, 0.4)),
          offset: 0.65,
          transform: 'translateY(-1px)',
        },
        { clipPath: cssPath(materialPath(0, 0, box.width, box.height, 14, 0)), transform: 'none' },
      ],
      { duration: 510, easing: 'cubic-bezier(.22,1,.36,1)' },
    );
  }
  function togglePanel(element, visible) {
    const old = regionMotions.get(element);
    old?.animations.forEach((a) => a.cancel());
    if (visible) {
      element.hidden = false;
      morphRegion(element, null, { duration: 420 });
    } else if (!state.motion || element.hidden) {
      element.hidden = true;
    } else {
      const rect = element.getBoundingClientRect();
      const animation = element.animate(
        [
          {
            height: rect.height + 'px',
            clipPath: cssPath(materialPath(0, 0, rect.width, rect.height, 16, 0)),
          },
          { height: '0px', clipPath: cssPath(materialPath(0, 0, rect.width * 0.4, 1, 1, 0.4)) },
        ],
        { duration: 260, easing: 'cubic-bezier(.6,0,.8,.4)' },
      );
      const record = { animations: [animation] };
      regionMotions.set(element, record);
      animation.finished
        .then(() => {
          if (regionMotions.get(element) === record) {
            element.hidden = true;
            regionMotions.delete(element);
          }
        })
        .catch(() => {});
    }
  }

  // A single clock per visible demo. Timers are cleared when hidden, paused or removed.
  const demoPlayers = new Set();
  class DemoTimeline {
    constructor(root, build) {
      this.root = root;
      this.build = build;
      this.queue = [];
      this.index = 0;
      this.timer = 0;
      this.remaining = null;
      this.speed = 1;
      this.paused = false;
      this.visible = false;
      this.instant = false;
      this.follow = true;
      this.observer = new IntersectionObserver(
        (entries) => {
          this.visible = entries[0].isIntersecting;
          this.sync();
        },
        { threshold: 0.025 },
      );
      this.observer.observe(root);
      root._player = this;
      demoPlayers.add(this);
    }
    playable() {
      return (
        this.root.isConnected &&
        this.visible &&
        !this.root.closest('[hidden]') &&
        !document.hidden &&
        !this.paused &&
        (!this.root.closest('dialog') || this.root.closest('dialog').open) &&
        (!document.querySelector('dialog[open]') || !!this.root.closest('dialog[open]')) &&
        !state.transitioning &&
        !this.root.closest('dialog.is-morphing')
      );
    }
    clear() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = 0;
        this.remaining = Math.max(0, this.deadline - performance.now());
      }
    }
    load(queue) {
      this.clear();
      this.queue = queue;
      this.index = 0;
      this.remaining = null;
      this.paused = false;
      this.instant = false;
      this.follow = true;
      this.sync();
    }
    sync() {
      if (!this.root.isConnected) {
        this.clear();
        return;
      }
      if (!state.motion) {
        this.finish();
        return;
      }
      if (!this.playable()) {
        this.clear();
        this.status();
        return;
      }
      this.status();
      if (this.timer || this.index >= this.queue.length) return;
      const job = this.queue[this.index],
        delay = this.remaining ?? job.delay / this.speed;
      this.remaining = null;
      this.deadline = performance.now() + delay;
      this.timer = setTimeout(() => {
        this.timer = 0;
        if (!this.playable()) {
          this.remaining = 0;
          return;
        }
        job.run();
        this.index++;
        this.sync();
      }, delay);
    }
    finish() {
      this.clear();
      this.instant = true;
      while (this.index < this.queue.length) {
        this.queue[this.index++].run();
      }
      this.instant = false;
      this.remaining = null;
      this.status();
    }
    status() {
      const done = this.index >= this.queue.length,
        paused = this.paused || !state.motion;
      const label = $('[data-demo-status]', this.root);
      if (label) label.textContent = done ? tr('Готово') : paused ? tr('На паузе') : tr('Воспроизведение');
      const pause = $('[data-demo-pause]', this.root);
      if (pause) {
        pause.disabled = done || !state.motion;
        pause.setAttribute(
          'aria-label',
          this.paused ? 'Продолжить демонстрацию' : 'Приостановить демонстрацию',
        );
        pause.innerHTML = icons(this.paused ? 'play' : 'pause');
      }
      const speed = $('[data-demo-speed]', this.root);
      if (speed) {
        speed.textContent = this.speed + '×';
        speed.setAttribute('aria-label', 'Скорость демонстрации ' + this.speed + '×. Изменить');
      }
    }
    toggle() {
      if (this.index >= this.queue.length) return;
      this.paused = !this.paused;
      this.sync();
    }
    replay() {
      this.build();
    }
    changeSpeed() {
      this.clear();
      const old = this.speed;
      this.speed = old === 1 ? 2 : 1;
      if (this.remaining !== null) this.remaining *= old / this.speed;
      this.sync();
    }
    destroy() {
      this.clear();
      this.observer.disconnect();
      demoPlayers.delete(this);
      delete this.root._player;
      delete this.root.dataset.mounted;
      this.root._cleanup?.();
    }
  }
  function syncDemos() {
    demoPlayers.forEach((player) => player.sync());
  }
  function destroyDemos(scope) {
    [...demoPlayers].forEach((player) => {
      if (scope.contains(player.root)) player.destroy();
    });
  }
  document.addEventListener('visibilitychange', syncDemos);
  const TERMINAL_TITLES = {
    bugfix: 'xli — ~/go/src/worker',
    headless: 'xli --headless · CI job #4821',
    tui: 'XliTui — Textual · MCP: 6',
    nvim: 'nvim — handler.go',
    terminal: 'python3 -m xli.ui.terminal',
    safety: 'SafeShell — blocked command',
  };
  function terminalFrame(id, key, compact = false) {
    return (
      '<div id="' + id + '" data-terminal="' + key + '"' + (compact ? ' data-compact="true"' : '') + '></div>'
    );
  }
  function controls() {
    return (
      '<div class="demo-controls"><button class="demo-control" type="button" data-demo-speed aria-label="Изменить скорость">1×</button><button class="demo-control" type="button" data-demo-pause aria-label="Приостановить демонстрацию">' +
      icons('pause') +
      '</button><button class="demo-control" type="button" data-demo-replay aria-label="Повторить демонстрацию">' +
      icons('replay') +
      '</button></div>'
    );
  }
  function bindPlayerControls(root, player) {
    $('[data-demo-replay]', root)?.addEventListener('click', () => player.replay());
    $('[data-demo-pause]', root)?.addEventListener('click', () => player.toggle());
    $('[data-demo-speed]', root)?.addEventListener('click', () => player.changeSpeed());
  }
  function mountTerminal(root) {
    if (root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const compact = root.dataset.compact === 'true';
    root.classList.add('demo-terminal');
    root.classList.toggle('compact-terminal', compact);
    root.innerHTML =
      '<div class="demo-terminal-head"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="demo-terminal-caption"></span>' +
      controls() +
      '</div><div class="demo-terminal-output" tabindex="0" role="region" aria-label="Предпросмотр терминала"></div><div class="demo-terminal-status"><span><i aria-hidden="true"></i><span data-demo-status>Демонстрация</span></span><span>PREVIEW</span></div>';
    const output = $('.demo-terminal-output', root);
    let player;
    function rebuild() {
      player?.clear();
      output.replaceChildren();
      const key = root.dataset.terminal,
        sub = key.startsWith('system:') ? ORIGINAL_DEMOS.SUBSYSTEMS.find((s) => s.id === key.slice(7)) : null;
      $('.demo-terminal-caption', root).textContent = sub
        ? sub.title + ' · ' + sub.tag
        : TERMINAL_TITLES[key] || key;
      const script = sub
        ? sub.demo
        : {
            bugfix: ORIGINAL_DEMOS.xliTerminalScripts,
            headless: ORIGINAL_DEMOS.headlessScripts,
            nvim: ORIGINAL_DEMOS.nvimScripts,
            terminal: ORIGINAL_DEMOS.terminalQnaScripts,
            safety: ORIGINAL_DEMOS.safeShellScripts,
          }[key] || [];
      const jobs = [];
      const job = (run, delay = 150) => jobs.push({ run, delay });
      const follow = () => {
        if (player.follow) output.scrollTop = output.scrollHeight;
      };
      const append = (html, cls = '', delay = 140) => {
        const line = document.createElement('div');
        line.className = 't-line ' + cls;
        line.innerHTML = html;
        job(() => {
          output.append(line);
          if (state.motion && !player.instant) line.classList.add('is-revealing');
          follow();
        }, delay);
        return line;
      };
      const type = (prefix, text, cls = 't-cmd', delay = 180) => {
        const line = append(prefix + '<span class="' + cls + ' t-caret"></span>', '', delay);
        for (let i = 2; i < text.length + 2; i += 2) {
          const part = text.slice(0, i);
          job(() => {
            line.innerHTML = prefix + '<span class="' + cls + ' t-caret">' + escapeHTML(part) + '</span>';
            follow();
          }, 18);
        }
        job(() => {
          line.innerHTML = prefix + '<span class="' + cls + '">' + escapeHTML(text) + '</span>';
          follow();
        }, 90);
      };
      if (key === 'tui') {
        const t = ORIGINAL_DEMOS.tuiTexts;
        append(escapeHTML(t.header1), 't-comment');
        append('PLAN → CODER → DEBUGGER → TESTER → OPTIMIZER → REVIEWER', 't-agent');
        const grid = document.createElement('div');
        grid.className = 'tui-grid';
        const agents = ['CODER', 'DEBUGGER', 'TESTER', 'OPTIMIZER', 'REVIEWER'];
        agents.forEach((name) => {
          const cell = document.createElement('div');
          cell.className = 'tui-agent';
          cell.innerHTML =
            '<div class="tui-agent-head"><span>' +
            name +
            '</span><output>0%</output></div><div class="tui-progress"><span></span></div><small>WAITING</small>';
          grid.append(cell);
        });
        job(() => {
          output.append(grid);
          follow();
        }, 220);
        [...grid.children].forEach((cell) => {
          for (let n = 20; n <= 100; n += 20) {
            job(() => {
              $('output', cell).textContent = n + '%';
              $('.tui-progress', cell).style.setProperty('--progress', n + '%');
              $('small', cell).textContent = n === 100 ? 'DONE' : 'RUNNING';
              cell.classList.toggle('is-done', n === 100);
            }, 100);
          }
        });
        append('LIVE LOG', 't-comment', 240);
        t.logs.forEach((line) => append(escapeHTML(line.text), line.cls, 200));
        append(escapeHTML(t.statusBar), 't-comment', 200);
      } else {
        script.forEach((step) => {
          if (step.type === 'prompt') {
            type(
              '<span class="t-prompt">➜ </span><span class="t-path">' + escapeHTML(step.path) + ' </span>',
              step.cmd,
            );
          } else if (step.type === 'agent') {
            append('◈ ' + escapeHTML(step.text), 't-agent', 200);
          } else if (step.type === 'plain') {
            append(step.text ? escapeHTML(step.text) : '', 't-comment', 60);
          } else if (step.type === 'step') {
            append((step.done ? '✓ ' : '↳ ') + escapeHTML(step.text), step.done ? 't-ok' : 't-warn', 220);
          } else if (step.type === 'toolcall') {
            append(
              '<span class="t-kw">⚙ tool </span><span class="t-func">' +
                escapeHTML(step.tool) +
                '</span>(<span class="t-string">' +
                escapeHTML(step.args) +
                '</span>)',
              '',
              230,
            );
          } else if (step.type === 'out' || step.type === 'diff') {
            step.lines.forEach((line) => append(escapeHTML(line.text), line.cls, 110));
          } else if (step.type === 'raw') {
            // Original data contains only presentational spans; all text is re-escaped.
            const template = document.createElement('template');
            template.innerHTML = step.html;
            const text = template.content.textContent,
              first = template.content.querySelector('span');
            const cls =
              first?.className
                ?.split(' ')
                .filter((c) => /^t-[a-z-]+$/.test(c))
                .join(' ') || 't-comment';
            append(escapeHTML(text), cls, 140);
          } else if (step.type === 'question' || step.type === 'nvimq') {
            append('? ' + escapeHTML(step.q), 't-agent', 260);
            step.options.forEach((option, i) =>
              append('  ' + (i + 1) + ') ' + escapeHTML(option), 't-comment', 90),
            );
            type(
              '<span class="t-input-label">Select: </span>',
              String(step.selectIndex + 1),
              't-opt-sel',
              200,
            );
            append('✓ ' + escapeHTML(step.options[step.selectIndex]), 't-opt-sel', 150);
          } else if (step.type === 'input') {
            append(
              '? ' + escapeHTML(step.q) + (step.default ? ' [' + escapeHTML(step.default) + ']' : ''),
              't-input-label',
              200,
            );
            if (step.typeText) type('  ', step.typeText, 't-opt-sel', 150);
            else append('↵ Значение по умолчанию: ' + escapeHTML(step.default || ''), 't-default', 250);
          } else if (step.type === 'answer') {
            append('◈ XLI  ' + escapeHTML(step.text), 't-agent', 250);
          } else if (step.type === 'idle' || step.type === 'prompt-idle') {
            append(
              '<span class="t-prompt">➜ </span><span class="t-path">' +
                escapeHTML(step.path || '~/go/src/worker') +
                '</span>',
              '',
              150,
            );
          }
        });
      }
      player.load(jobs);
    }
    player = new DemoTimeline(root, rebuild);
    bindPlayerControls(root, player);
    output.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaY < 0) player.follow = false;
      },
      { passive: true },
    );
    output.addEventListener(
      'touchstart',
      () => {
        player.follow = false;
      },
      { passive: true },
    );
    output.addEventListener('keydown', (event) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) player.follow = false;
    });
    output.addEventListener(
      'scroll',
      () => {
        if (output.scrollHeight - output.scrollTop - output.clientHeight < 9) player.follow = true;
      },
      { passive: true },
    );
    rebuild();
  }

  const CHAT_PROMPT = 'Сравни курс доллара за неделю и покажи график';
  const CHAT_VALUES = [89.6, 89.82, 89.71, 90.12, 90.42, 90.18, 90.85];
  function chartMarkup() {
    return '<div class="chat-chart"><div class="chat-chart-label"><span>USD / RUB · DEMO</span><strong>+1,4%</strong></div><svg viewBox="0 0 280 100" role="img" aria-label="Демонстрационный график курса, не текущие котировки"><path class="chart-grid" d="M0 25H280M0 50H280M0 75H280"/><path class="chart-fill" d="M0 77C20 77 22 66 40 66S64 78 80 72S102 51 120 49S143 25 160 24S183 46 200 38S228 31 240 24S263 21 280 13V100H0Z"/><path class="chart-stroke" d="M0 77C20 77 22 66 40 66S64 78 80 72S102 51 120 49S143 25 160 24S183 46 200 38S228 31 240 24S263 21 280 13"/></svg><div class="chat-chart-axis"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span><span>СБ</span><span>ВС</span></div></div>';
  }
  function chatFrame(id, compact = false) {
    return '<div id="' + id + '" data-chat' + (compact ? ' data-compact="true"' : '') + '></div>';
  }
  function mountChat(root) {
    if (root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const compact = root.dataset.compact === 'true';
    root.classList.add('chat-demo');
    root.classList.toggle('compact-chat', compact);
    root.innerHTML =
      '<div class="chat-topbar"><span class="chat-avatar">' +
      icons('robot') +
      '</span><div class="chat-topbar-title">XGO Bot<small data-demo-status>' +
      tr('Воспроизведение') +
      '</small></div><span class="demo-tag">PREVIEW</span>' +
      controls() +
      '</div><div class="chat-feed tg-demo" role="region" aria-label="' +
      tr('Предпросмотр XGO: сообщение, дерево, ответ и клавиатура') +
      '"></div><form class="chat-composer"><div class="chat-scenarios"><button type="button" data-chat-scenario="currency">' +
      tr('Курс + график') +
      '</button><button type="button" data-chat-scenario="table">' +
      tr('Таблица инструментов') +
      '</button><button type="button" data-chat-scenario="code">GitHub + ' +
      tr('код') +
      '</button></div><div class="chat-input-row"><input type="text" maxlength="400" aria-label="' +
      tr('Запрос для предпросмотра XGO') +
      '" placeholder="' +
      tr('Напиши тестовый запрос…') +
      '" autocomplete="off"><button class="chat-send" type="submit" aria-label="' +
      tr('Проиграть демо с этим запросом') +
      '">' +
      icons('telegram') +
      '</button></div><p class="chat-composer-note">' +
      tr('') +
      '</p></form>';
    const feed = $('.chat-feed', root),
      input = $('input', root),
      history = [];
    let currentPrompt = tr(CHAT_PROMPT),
      treeVisible = true,
      reaction = null,
      urls = [],
      player;
    const userMessage = (prompt) => {
      const node = document.createElement('div');
      node.className = 'chat-message from-user tg-msg-user';
      node.innerHTML =
        '<div class="chat-bubble tg-bubble-user" data-user-text>' + escapeHTML(prompt) + '</div>';
      return node;
    };
    const botMessage = (html) => {
      const node = document.createElement('div');
      node.className = 'chat-message tg-msg-bot';
      node.innerHTML =
        '<span class="message-avatar" aria-hidden="true">' +
        icons('robot') +
        '</span><div class="tg-bubble-col">' +
        html +
        '</div>';
      return node;
    };
    function releaseURLs() {
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls = [];
    }
    root._cleanup = releaseURLs;
    function scenario(prompt) {
      if (/github|git|код|code|build|сборк|репозит|diff/i.test(prompt))
        return {
          kind: 'code',
          steps: [
            { text: tr('Читаю репозиторий из примера'), tool: 'github_read(path="cmd/worker")' },
            { text: tr('Проверяю вызов process()'), tool: 'read_files("handler.go")' },
            { text: tr('Готовлю правку и проверку'), tool: 'github_commit(+1, −1) → actions(test)' },
            { text: tr('Готово') },
          ],
          answer: tr(
            'Пример исправления: process(job) → process(&job). Функция ожидает *Job, проверка go test проходит.',
          ),
          extra: '<div class="chat-data-note"><code>− process(job)<br>+ process(&amp;job)</code></div>',
        };
      if (/таблиц|инструмент|table|tools/i.test(prompt))
        return {
          kind: 'table',
          steps: [
            { text: tr('Выбираю данные для примера'), tool: 'context(project_tools)' },
            { text: tr('Собираю структуру таблицы'), tool: 'exec_code(python)' },
            { text: tr('Готовлю ответ и файл'), tool: 'table() → file(csv)' },
            { text: tr('Готово') },
          ],
          answer: tr(
            'В XGO есть инструменты поиска, расчётов, визуализаций, файлов и GitHub. В этом демо собрал небольшую таблицу возможностей.',
          ),
          extra:
            '<div class="chat-data-note">Web Search → ' +
            tr('поиск') +
            '<br>Exec Code → ' +
            tr('расчёты') +
            '<br>Chart → ' +
            tr('графики') +
            '<br>GitHub → ' +
            tr('код и проверки') +
            '</div>',
        };
      if (/курс|доллар|usd|график|chart|currency|dollar/i.test(prompt))
        return {
          kind: 'currency',
          steps: ORIGINAL_DEMOS.xgoReasoningScripts.map((s) => ({ text: s.text, tool: s.tool })),
          answer: tr('В примере USD вырос на 1,4% за неделю. Ниже — график дневных значений.'),
          extra: chartMarkup(),
        };
      return {
        kind: 'custom',
        steps: [
          { text: tr('Запрос принят'), tool: 'demo_input()' },
          { text: tr('Показываю структуру агентного цикла'), tool: 'plan → tools → response' },
          { text: tr('Готово') },
        ],
        answer: tr(
          'Для этого предпросмотра доступны три сценария: «Курс + график», «Таблица инструментов» и «GitHub + код». Выбери один из них ниже.',
        ),
        extra: '',
      };
    }
    function keyboard() {
      return (
        '<div class="chat-keyboard tg-keyboard"><button type="button" data-chat-action="continue">' +
        icons('arrow-right') +
        '<span>' +
        tr('Продолжить') +
        '</span></button><button type="button" data-chat-action="edit">' +
        icons('edit') +
        '<span>' +
        tr('Реген с промптом') +
        '</span></button><button type="button" data-chat-action="regenerate">' +
        icons('replay') +
        '<span>' +
        tr('Регенерировать') +
        '</span></button><button type="button" data-chat-action="clear">' +
        icons('trash') +
        '<span>' +
        tr('Очистить') +
        '</span></button><button type="button" data-chat-action="history" aria-expanded="false">' +
        icons('history') +
        '<span>' +
        tr('История') +
        '</span></button><button type="button" data-chat-action="tree" aria-expanded="' +
        treeVisible +
        '">' +
        icons('nodes') +
        '<span>' +
        tr('Дерево') +
        '</span></button><button type="button" data-chat-action="files" aria-expanded="false">' +
        icons('file') +
        '<span>' +
        tr('Файлы') +
        '</span></button></div>'
      );
    }
    function replay(prompt = currentPrompt, remember = false) {
      player?.clear();
      releaseURLs();
      feed.replaceChildren();
      currentPrompt = prompt;
      reaction = null;
      if (remember) {
        history.unshift(prompt);
        if (history.length > 8) history.pop();
      }
      const data = scenario(prompt),
        jobs = [],
        job = (run, delay = 160) => jobs.push({ run, delay });
      const user = userMessage(prompt),
        bot = botMessage(
          '<div class="chat-tree tg-bubble-tree"><div class="chat-tree-header">' +
            icons('nodes') +
            '<span>' +
            tr('Дерево действий') +
            '</span></div><div class="chat-tree-lines"></div></div>',
        ),
        col = $('.tg-bubble-col', bot),
        tree = $('.chat-tree', bot);
      tree.hidden = !treeVisible;
      job(() => {
        feed.append(user);
        popMessage(user, player.instant);
      }, 40);
      job(() => {
        feed.append(bot);
        popMessage(bot, player.instant);
      }, 200);
      const stepIcons = ['code', 'search', 'terminal', 'chart', 'check'];
      data.steps.forEach((step, i) => {
        const row = document.createElement('div');
        row.className = 'chat-tree-line is-active';
        row.innerHTML =
          '<span class="tree-connector" aria-hidden="true">' +
          (i === data.steps.length - 1 ? '└' : '├') +
          '</span><span class="tree-symbol" aria-hidden="true">' +
          icons(stepIcons[i % stepIcons.length]) +
          '</span><span>' +
          escapeHTML(step.text) +
          (step.tool ? '<code>' + escapeHTML(step.tool) + '</code>' : '') +
          '</span>';
        job(
          () => {
            $('.chat-tree-lines', tree).append(row);
            if (!player.instant) popMessage(row);
          },
          i ? 170 : 20,
        );
        job(() => {
          row.classList.remove('is-active');
          $('.tree-symbol', row).innerHTML = icons('check');
        }, 390);
      });
      const answer = document.createElement('div');
      answer.className = 'chat-bubble chat-answer tg-bubble-answer';
      answer.innerHTML = '<p class="chat-answer-text"></p><div class="chat-answer-extra"></div>';
      job(() => {
        col.append(answer);
        popMessage(answer, player.instant);
      }, 130);
      for (let i = 4; i < data.answer.length + 4; i += 4) {
        const part = data.answer.slice(0, i);
        job(() => {
          $('.chat-answer-text', answer).textContent = part;
        }, 15);
      }
      job(() => {
        $('.chat-answer-extra', answer).innerHTML = data.extra;
        const chart = $('.chat-chart', answer);
        if (chart && state.motion && !player.instant) chart.classList.add('is-drawing');
      }, 160);
      const reactions = document.createElement('div');
      reactions.className = 'chat-reactions tg-reactions';
      reactions.innerHTML =
        '<button class="chat-reaction" type="button" data-reaction="like" aria-pressed="false" aria-label="' +
        tr('Нравится, демонстрационная реакция') +
        '">' +
        icons('thumbs-up') +
        '<span>12</span></button><button class="chat-reaction" type="button" data-reaction="dislike" aria-pressed="false" aria-label="' +
        tr('Не нравится, демонстрационная реакция') +
        '">' +
        icons('thumbs-down') +
        '<span>1</span></button>';
      const fragment = document.createElement('div');
      fragment.innerHTML =
        keyboard() + '<div class="chat-history" hidden></div><div class="chat-attachments" hidden></div>';
      job(() => {
        col.append(reactions, ...fragment.childNodes);
        popMessage(reactions, player.instant);
        popMessage($('.chat-keyboard', col), player.instant);
      }, 120);
      const csv =
        data.kind === 'currency'
          ? 'day,usd_rub_demo\n' + CHAT_VALUES.map((v, i) => i + 1 + ',' + v.toFixed(2)).join('\n')
          : 'tool,purpose\nWeb Search,search\nExec Code,calculations\nChart,visualization\nGitHub,repository';
      const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
      urls.push(url);
      const filename = data.kind === 'currency' ? 'usd-rub-demo.csv' : 'xgo-tools-demo.csv';
      $('.chat-attachments', fragment).innerHTML =
        '<p>' +
        tr('Демонстрационный файл, созданный в браузере.') +
        '</p><a href="' +
        url +
        '" download="' +
        filename +
        '">' +
        icons('file') +
        '<span>' +
        filename +
        '</span>' +
        icons('download') +
        '</a>';
      player.load(jobs);
      if (remember && root.getClientRects().length)
        root.scrollIntoView({ block: 'start', behavior: state.motion ? 'smooth' : 'instant' });
    }
    player = new DemoTimeline(root, () => replay());
    bindPlayerControls(root, player);
    root._changeLanguage = () => {
      if (!history.length) currentPrompt = tr(CHAT_PROMPT);
      replay();
    };
    $('.chat-composer', root).addEventListener('submit', (event) => {
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) {
        input.focus();
        return;
      }
      input.value = '';
      replay(prompt, true);
    });
    root.addEventListener('click', (event) => {
      const preset = event.target.closest('[data-chat-scenario]');
      if (preset) {
        const prompts = {
          currency: tr(CHAT_PROMPT),
          table: tr('Собери таблицу инструментов XGO'),
          code: tr('Проверь сборку через GitHub и покажи diff'),
        };
        replay(prompts[preset.dataset.chatScenario], true);
        return;
      }
      const react = event.target.closest('[data-reaction]');
      if (react) {
        reaction = reaction === react.dataset.reaction ? null : react.dataset.reaction;
        $$('[data-reaction]', root).forEach((button) => {
          const on = button.dataset.reaction === reaction;
          button.setAttribute('aria-pressed', String(on));
          $('span', button).textContent = (button.dataset.reaction === 'like' ? 12 : 1) + (on ? 1 : 0);
        });
        return;
      }
      const choice = event.target.closest('[data-chat-history-index]');
      if (choice) {
        replay(history[Number(choice.dataset.chatHistoryIndex)]);
        return;
      }
      const button = event.target.closest('[data-chat-action]');
      if (!button) return;
      const action = button.dataset.chatAction;
      if (action === 'regenerate') replay();
      else if (action === 'edit') {
        input.value = currentPrompt;
        input.focus();
        input.select();
      } else if (action === 'clear') {
        player.load([]);
        releaseURLs();
        feed.replaceChildren();
        input.value = '';
        const welcome = botMessage(
          '<div class="chat-bubble">' +
            tr('Демо-чат очищен. Напиши тестовый запрос или выбери сценарий ниже.') +
            '</div><div class="chat-keyboard"><button type="button" data-chat-action="history" aria-expanded="false">' +
            icons('history') +
            '<span>' +
            tr('История') +
            '</span></button></div><div class="chat-history" hidden></div>',
        );
        feed.append(welcome);
        popMessage(welcome);
        input.focus();
      } else if (action === 'continue') {
        const next = botMessage(
          '<div class="chat-bubble">' +
            tr(
              'Можно уточнить период, запросить таблицу или перейти к проверке кода. Выбери сценарий ниже.',
            ) +
            '</div>',
        );
        feed.append(next);
        popMessage(next);
      } else if (action === 'tree') {
        treeVisible = !treeVisible;
        button.setAttribute('aria-expanded', String(treeVisible));
        const tree = $('.chat-tree', root);
        if (tree) togglePanel(tree, treeVisible);
      } else if (action === 'files') {
        const panel = $('.chat-attachments', root);
        if (!panel) return;
        const visible = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(visible));
        togglePanel(panel, visible);
      } else if (action === 'history') {
        const panel = $('.chat-history', root);
        if (!panel) return;
        const visible = button.getAttribute('aria-expanded') !== 'true';
        button.setAttribute('aria-expanded', String(visible));
        if (visible)
          panel.innerHTML = history.length
            ? '<p>' +
              tr('Последние запросы в этом предпросмотре:') +
              '</p>' +
              history
                .map(
                  (prompt, i) =>
                    '<button type="button" data-user-text data-chat-history-index="' +
                    i +
                    '">' +
                    escapeHTML(prompt) +
                    '</button>',
                )
                .join('')
            : '<p>' + tr('Пока нет запросов. Попробуй поле ввода или готовый сценарий.') + '</p>';
        togglePanel(panel, visible);
      }
    });
    replay();
  }

  function mountDemos(scope = document) {
    const terminals = [
      ...(scope.matches?.('[data-terminal]') ? [scope] : []),
      ...$$('[data-terminal]', scope),
    ];
    terminals.forEach(mountTerminal);
    const chats = [...(scope.matches?.('[data-chat]') ? [scope] : []), ...$$('[data-chat]', scope)];
    chats.forEach(mountChat);
  }
  function descriptionMarkup(data) {
    return (
      '<span class="file-chip">' +
      escapeHTML(data.tag) +
      '</span><h3>' +
      escapeHTML(data.title) +
      '</h3><p>' +
      escapeHTML(data.description || data.desc) +
      '</p><ul class="demo-bullets">' +
      data.features.map((text) => '<li>' + escapeHTML(text) + '</li>').join('') +
      '</ul>'
    );
  }
  function changeInterface(mode) {
    if (!UI_MODES[mode]) return;
    $$('[data-interface]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.interface === mode)),
    );
    morphRegion($('#interface-stage'), () => {
      $('#interface-description').innerHTML = descriptionMarkup(UI_MODES[mode]);
      const terminal = $('#lab-interface');
      terminal.dataset.terminal = mode;
      terminal._player?.replay();
    });
  }
  function changeSystem(id) {
    const index = ORIGINAL_DEMOS.SUBSYSTEMS.findIndex((system) => system.id === id);
    if (index < 0) return;
    $$('[data-system]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.system === id)),
    );
    $('#system-counter').textContent = String(index + 1).padStart(2, '0') + ' / 14';
    morphRegion($('#system-stage'), () => {
      $('#system-description').innerHTML = descriptionMarkup(ORIGINAL_DEMOS.SUBSYSTEMS[index]);
      const terminal = $('#lab-system');
      terminal.dataset.terminal = 'system:' + id;
      terminal._player?.replay();
    });
  }
  let currentAgent = 'xli';
  function changeAgent(agent, animate = true) {
    if (!['xli', 'xgo'].includes(agent)) return;
    const previous = currentAgent;
    currentAgent = agent;
    $$('[data-agent]').forEach((button) => {
      const active = button.dataset.agent === agent;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    $('#agent-panel-xli').hidden = agent !== 'xli';
    $('#agent-panel-xgo').hidden = agent !== 'xgo';
    if (animate && previous !== agent) morphRegion($('#agent-panel-' + agent), null, { duration: 590 });
    syncDemos();
  }
  async function openLab(agent, opener) {
    const dialog = opener?.closest('dialog');
    if (dialog?.open) await closeDialog(dialog);
    changeAgent(agent, false);
    switchView('lab', { focus: true, source: opener });
  }
  function initializeLab() {
    mountDemos();
    $$('[data-interface]').forEach((button) =>
      button.addEventListener('click', () => changeInterface(button.dataset.interface)),
    );
    $$('[data-system]').forEach((button) =>
      button.addEventListener('click', () => changeSystem(button.dataset.system)),
    );
    $$('[data-agent]').forEach((button) => {
      button.addEventListener('click', () => changeAgent(button.dataset.agent));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const agent =
          event.key === 'Home' ? 'xli' : event.key === 'End' ? 'xgo' : currentAgent === 'xli' ? 'xgo' : 'xli';
        changeAgent(agent);
        $('#agent-tab-' + agent).focus();
      });
    });
    let compressed = false,
      counterFrame = 0;
    $('#compress-memory').addEventListener('click', () => {
      compressed = !compressed;
      const button = $('#compress-memory');
      button.setAttribute('aria-pressed', String(compressed));
      button.innerHTML =
        (compressed ? 'Развернуть историю' : 'Сжать контекст') + icons(compressed ? 'replay' : 'spark');
      morphRegion(
        $('#memory-paper'),
        () => {
          $('#memory-paper').classList.toggle('is-compressed', compressed);
          $('#memory-label').textContent = compressed
            ? 'После сжатия / рабочее резюме'
            : 'До сжатия / полная история';
          $('#memory-text').textContent = compressed
            ? 'Резюме: пользователь деплоит проект X на сервер Y, использует .env с 4 переменными, включил ротацию логов, откат делает через тег предыдущего релиза.'
            : 'Пользователь: расскажи про проект, потом уточнял детали по деплою три раза, потом спрашивал про переменные окружения, затем про логи, затем про откат версии…';
        },
        { duration: 620 },
      );
      cancelAnimationFrame(counterFrame);
      const count = $('#memory-count'),
        from = Number(count.dataset.value || 3400),
        to = compressed ? 180 : 3400,
        start = performance.now();
      function tick(now) {
        const t = state.motion ? clamp((now - start) / 620, 0, 1) : 1;
        const value = Math.round(lerp(from, to, easeOut(t)));
        count.dataset.value = String(value);
        count.textContent = '~' + new Intl.NumberFormat('ru-RU').format(value);
        if (t < 1) counterFrame = requestAnimationFrame(tick);
      }
      counterFrame = requestAnimationFrame(tick);
    });
  }

  function projectExtra(id) {
    if (id === 'anon') return anonVoiceMarkup();
    if (id === 'xli')
      return '<div class="detail-extra"><h3>Интерфейс под задачу.</h3><p>HeadlessUI, Textual TUI с пятью агентами, Neovim, TerminalQuestionnaire, SafeShell и 14 подсистем. XPI поддерживает hot-reload и общий стейт между интерфейсами.</p></div>';
    if (id === 'xgo')
      return '<div class="detail-extra"><h3>Больше, чем окно переписки.</h3><p>10 инструментов, сжатие контекста, история запросов и мультипровайдерный fallback. Всё необходимое для работы с длинными задачами.</p></div>';
    if (id === 'firstplatform')
      return `<div class="detail-extra">
          <h3>Как попасть в First Platform</h3><p>Основатель — ZFliers (@NOZF_liers / @ZF_LIERS). Здесь блогеры, стримеры и авторы каналов находят партнёров, общаются, делятся идеями и рассказывают о своих проектах. Администрация помогает по возможности.</p>
          <details open><summary>Заявка и критерии</summary><p>Пиши <strong>лично администрации проекта</strong>, не модераторам, не в общий чат и не владельцу по поводу заявки. Для каждой платформы нужна отдельная заявка.</p><div class="criteria-mini"><div><strong>Twitch</strong><span>От 20 подписчиков</span></div><div><strong>VK Video</strong><span>От 140 подписчиков</span></div><div><strong>RuTube</strong><span>От 170 подписчиков</span></div><div><strong>YouTube</strong><span>От 40 подписчиков</span></div><div><strong>Telegram</strong><span>От 20 подписчиков</span></div><div><strong>TikTok</strong><span>От 200 подписчиков</span></div></div><p>Возраст владельца — от 13 лет. Последний ролик или стрим — не более двух месяцев назад; для Telegram последнее сообщение — не более месяца назад. В проекте допускается не более 14 дней неактива.</p><p>Перед заявкой проверь данные, напиши сразу по делу и дождись проверки. Для тех, кто пока не проходит по критериям, предусмотрен отдельный чат для роста аудитории.</p><p>Для Telegram не принимаются лайф-контент, казино, 18+, «деф», work, биографии, пустые каналы, живодёрство и материалы, нарушающие закон. Актуальные условия уточняй у администрации.</p></details>
          <details><summary>Администрация и каналы</summary><p>Вопросы по проекту — модерации. Вопросы по рекламе — @ZF_LIERS.</p><ul><li>@Vpkino: <a href="https://t.me/VP12347" target="_blank" rel="noopener noreferrer">Telegram</a> · <a href="https://youtube.com/@V.P117?si=_PqiFdSb3o1fvj_o" target="_blank" rel="noopener noreferrer">YouTube</a></li><li>@Creeper_im_girl: <a href="https://t.me/sofie_fi" target="_blank" rel="noopener noreferrer">Telegram</a> · <a href="https://youtube.com/channel/UCmtQLpl4w30dybeEt3Nv5dQ?si=GFDKX-DeBVdyetkb" target="_blank" rel="noopener noreferrer">YouTube</a></li><li>@Repyshek: <a href="https://t.me/MIFFCHANELLYT" target="_blank" rel="noopener noreferrer">Telegram</a> · <a href="https://www.youtube.com/@MIFFCHANELL" target="_blank" rel="noopener noreferrer">YouTube</a></li></ul></details>
        </div>`;
    if (id === 'clawback')
      return `<div class="detail-extra"><h3>WE TAKE IT ALL BACK.</h3><details open><summary>[manifesto]</summary><p>THE ERA OF CORPORATE OPPRESSION IS OVER.<br>DATA IS POWER.<br>AND WE RECLAIM IT FOR THE PEOPLE.</p></details><details><summary>[mission]</summary><p>Target systems of corruption.<br>Expose systemic injustice.<br>Reclaim stolen public data.<br>Liberate digital networks.</p></details><details><summary>[exposé targets]</summary><p>WE ARE MANY.<br><br>CORRUPT CORPORATIONS<br>UNETHICAL BIO-TECH<br>STATE SURVEILLANCE APPARATUS<br>FINANCIAL EXPLOITATION SYSTEMS</p></details><details><summary>[group profile]</summary><p>We are an amorphous, decentralized operative collective with no central command.</p><p>We wage war against corporate dictates, driven by the principles of total data liberation.</p><p>The data we reclaim is immediately returned to the public domain, for absolute transparency and societal emancipation.</p><p>Our fundamental mission is to expose the hidden agendas and shadow schemes of power structures, turning them inside out.</p></details><details><summary>[greets]</summary><p>GREETS to our allies in the digital underground.<br>We see you.<br><br>WE TAKE IT ALL BACK.<br>— 2026 — ???? —</p></details></div>`;
    if (id === 'anonshare')
      return '<div class="detail-extra"><h3>Сервер знакомит. Файл летит.</h3><p>Создал комнату → передал секретную ссылку → отправил файл. Комната временная, регистрации нет. Шифрование AES-GCM выполняется на клиенте, транспорт — защищённый DataChannel. Секрет находится после # и не отправляется сигналинг-серверу.</p><p>Архитектура открыта: клиент и сервер можно контролировать самостоятельно. STUN помогает установить соединение, TURN при необходимости ретранслирует зашифрованный трафик.</p><p><strong>Zero-Storage · P2P / AES-GCM · ClawBack RELEASE</strong></p></div>';
    return '';
  }

  const I18N_PAIRS = translations;
  const normalizeText = (value) => String(value).replace(/\s+/g, ' ').trim();
  const enByRu = new Map(Object.entries(I18N_PAIRS).map(([ru, en]) => [normalizeText(ru), en]));
  const ruByEn = new Map([...enByRu].map(([ru, en]) => [normalizeText(en), ru]));
  function tr(text) {
    const normalized = normalizeText(text),
      source = ruByEn.get(normalized) || normalized;
    if (preferences.lang !== 'en') return ruByEn.has(normalized) ? source : text;
    if (enByRu.has(source)) return enByRu.get(source);
    if (/^Интерфейс \/ графика /.test(normalized))
      return normalized.replace('Интерфейс / графика ', 'Interface / artwork ');
    if (/^Показано проектов: \d+\.$/.test(normalized))
      return 'Projects shown: ' + normalized.match(/\d+/)[0] + '.';
    if (/^Скорость демонстрации/.test(normalized))
      return normalized.replace('Скорость демонстрации', 'Demo speed').replace('Изменить', 'Change');
    return text;
  }
  const originalText = new WeakMap(),
    originalAttributes = new WeakMap();
  function translateScope(scope) {
    if (!scope?.isConnected) return;
    if (scope.nodeType === Node.TEXT_NODE) scope = scope.parentElement;
    if (!scope || scope.closest?.('script,style,noscript,[data-user-text],.demo-terminal-output,code,pre'))
      return;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement?.closest(
          'script,style,noscript,[data-user-text],.demo-terminal-output,code,pre',
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue;
      if (!value.trim()) continue;
      let record = originalText.get(node);
      if (!record || value !== record.output) {
        record = { source: ruByEn.get(normalizeText(value)) || value, output: value };
        originalText.set(node, record);
      }
      const translated = tr(record.source);
      if (value !== translated) {
        node.nodeValue = translated;
        record.output = translated;
      }
    }
    const elements = [scope, ...scope.querySelectorAll('[aria-label],[title],[placeholder],[alt]')];
    for (const element of elements) {
      if (element.nodeType !== 1 || element.closest('[data-user-text]')) continue;
      let records = originalAttributes.get(element);
      if (!records) {
        records = {};
        originalAttributes.set(element, records);
      }
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        let record = records[attr];
        if (!record || value !== record.output)
          record = records[attr] = { source: ruByEn.get(normalizeText(value)) || value, output: value };
        const translated = tr(record.source);
        if (value !== translated) {
          element.setAttribute(attr, translated);
          record.output = translated;
        }
      }
    }
  }
  function setLanguage(lang, replay = true) {
    preferences.lang = lang === 'en' ? 'en' : 'ru';
    storage.set('lang', preferences.lang);
    root.lang = preferences.lang;
    ORIGINAL_DEMOS = DEMO_DATA[preferences.lang];
    $$('[data-language]').forEach((button) =>
      button.setAttribute('aria-pressed', String(button.dataset.language === preferences.lang)),
    );
    document.title = preferences.lang === 'en' ? 'Aubeig — code with character' : 'Aubeig — код с характером';
    if (replay) {
      demoPlayers.forEach((player) => {
        if (player.root._changeLanguage) player.root._changeLanguage();
        else player.replay();
      });
      const active = $('[data-system][aria-pressed="true"]');
      if (active) {
        const data = ORIGINAL_DEMOS.SUBSYSTEMS.find((item) => item.id === active.dataset.system);
        if (data) $('#system-description').innerHTML = descriptionMarkup(data);
      }
    }
    translateScope(document.body);
    syncPills(replay && state.motion);
    moveNav(false);
  }
  function initializeLanguage() {
    setLanguage(preferences.lang, false);
    let scheduled = 0;
    const dirty = new Set();
    const observer = new MutationObserver((changes) => {
      changes.forEach((change) => {
        const target = change.type === 'characterData' ? change.target.parentElement : change.target;
        if (
          target?.nodeType === 1 &&
          !target.closest(
            'script,style,noscript,.window-snapshot,.morph-card-copy,[data-user-text],.demo-terminal-output,code,pre',
          )
        )
          dirty.add(target);
      });
      if (!dirty.size || scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        const scopes = [...dirty];
        dirty.clear();
        scopes.forEach(translateScope);
      });
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  }

  // Settings mirror index.html and remain usable without persistent storage.
  const validEffects = TRANSITION_STYLES;
  let effectSequence = 0;
  function chooseEffect(preferred) {
    return preferences.transition === 'mix'
      ? preferred || validEffects[effectSequence++ % validEffects.length]
      : preferences.transition;
  }
  function capsulePath(x, y, w, h) {
    const r = Math.min(w, h) * 0.43,
      k = 0.55228475,
      fmt = (n) => n.toFixed(2),
      p = (...v) => v.map(fmt).join(' ');
    return (
      'M ' +
      p(x + r, y) +
      ' H ' +
      fmt(x + w - r) +
      ' C ' +
      p(x + w - r + k * r, y, x + w, y + r - k * r, x + w, y + r) +
      ' V ' +
      fmt(y + h - r) +
      ' C ' +
      p(x + w, y + h - r + k * r, x + w - r + k * r, y + h, x + w - r, y + h) +
      ' H ' +
      fmt(x + r) +
      ' C ' +
      p(x + r - k * r, y + h, x, y + h - r + k * r, x, y + h - r) +
      ' V ' +
      fmt(y + r) +
      ' C ' +
      p(x, y + r - k * r, x + r - k * r, y, x + r, y) +
      ' Z'
    );
  }
  function spring(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return 1 - Math.exp(-7.5 * t) * (Math.cos(11.5 * t) + (7.5 / 11.5) * Math.sin(11.5 * t));
  }
  function surfaceMask(effect, w, h, t, origin = { x: w / 2, y: h / 2 }) {
    if (isDesktopMotion(effect)) return desktopMask(effect, w, h, t, origin.direction || 1);
    t = clamp(t, 0, 1);
    const eased = clamp(easeOut(t), 0, 1);
    if (effect === 'shutters') {
      return Array.from({ length: 5 }, (_, i) => {
        const p = easeOut(clamp((t - i * 0.052) / 0.78, 0, 1)),
          slice = w / 5,
          sw = Math.max(0.01, slice * p + 1);
        return materialPath(
          i * slice + (slice - sw) / 2,
          0,
          sw,
          h,
          Math.min(30, sw * 0.48),
          Math.sin(Math.PI * p) * 0.22,
        );
      }).join(' ');
    }
    if (effect === 'cascade') {
      const rows = Math.max(4, Math.ceil(h / Math.max(155, innerHeight * 0.24)));
      return Array.from({ length: rows }, (_, i) => {
        const p = clamp(spring(clamp((t - (i % 4) * 0.062) / 0.72, 0, 1)), 0, 1),
          band = h / rows,
          hh = Math.max(0.01, band * p + 1);
        return materialPath(0, i * band, w, hh, Math.min(27, hh * 0.4), Math.sin(Math.PI * p) * 0.45);
      }).join(' ');
    }
    if (effect === 'iris') {
      const grow = smooth(t),
        ww = lerp(Math.min(46, w), w, grow),
        hh = lerp(Math.min(46, h), h, grow);
      return materialPath(
        lerp(clamp(origin.x - 23, 0, w - 46), 0, eased),
        lerp(clamp(origin.y - 23, 0, h - 46), 0, eased),
        ww,
        hh,
        lerp(Math.min(ww, hh) * 0.46, 28, Math.pow(t, 3)),
        0,
      );
    }
    const p = clamp(spring(t), 0, 1),
      ww = lerp(Math.min(64, w), w, p),
      hh = lerp(Math.min(62, h), h, smooth(t));
    return materialPath(
      lerp(clamp(origin.x - 32, 0, Math.max(0, w - 64)), 0, p),
      lerp(clamp(origin.y - 31, 0, Math.max(0, h - 62)), 0, p),
      ww,
      hh,
      28 + Math.sin(Math.PI * t) * 56,
      Math.sin(Math.PI * t) * 0.72,
    );
  }

  // The thumb moves; the actual buttons never move their hit targets.
  const pillRecords = new WeakMap(),
    pillObserver = new ResizeObserver((entries) => entries.forEach((entry) => syncPill(entry.target, false)));
  function syncPill(group, animate = state.motion) {
    if (!group?.isConnected || !group.getClientRects().length || group.closest('[hidden]')) return;
    const selected = $(':scope>button[aria-pressed="true"],:scope>button[aria-selected="true"]', group);
    if (!selected) return;
    let thumb = $(':scope>.spring-thumb', group);
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'spring-thumb';
      thumb.setAttribute('aria-hidden', 'true');
      group.prepend(thumb);
    }
    const target = {
      x: selected.offsetLeft,
      y: selected.offsetTop,
      w: selected.offsetWidth,
      h: selected.offsetHeight,
    };
    const old = pillRecords.get(group),
      live = old?.animation ? thumb.getBoundingClientRect() : null,
      groupBox = group.getBoundingClientRect();
    const from = live
      ? {
          x: live.left - groupBox.left - group.clientLeft,
          y: live.top - groupBox.top - group.clientTop,
          w: live.width,
          h: live.height,
        }
      : old?.rect || target;
    old?.animation?.cancel();
    Object.assign(thumb.style, {
      left: target.x + 'px',
      top: target.y + 'px',
      width: target.w + 'px',
      height: target.h + 'px',
    });
    const record = { rect: target };
    pillRecords.set(group, record);
    if (
      animate &&
      state.motion &&
      Math.abs(from.x - target.x) + Math.abs(from.y - target.y) + Math.abs(from.w - target.w) > 1
    ) {
      record.animation = thumb.animate(
        [
          {
            transform: 'translate(' + (from.x - target.x) + 'px,' + (from.y - target.y) + 'px)',
            width: from.w + 'px',
            height: from.h + 'px',
            borderRadius: '17px',
          },
          {
            transform: 'translate(0,0)',
            width: target.w + 'px',
            height: target.h + 'px',
            borderRadius: '15px',
          },
        ],
        { duration: 610, easing: 'cubic-bezier(.34,1.56,.64,1)' },
      );
      record.animation.finished
        .catch(() => {})
        .then(() => {
          if (pillRecords.get(group) === record) delete record.animation;
        });
    }
  }
  function syncPills(animate = false) {
    $$('.spring-group').forEach((group) => syncPill(group, animate));
  }
  function initializePills() {
    $$('.agent-tabs,.interface-picker,.filters').forEach((group) => group.classList.add('spring-group'));
    const selectionObserver = new MutationObserver((changes) => {
      const groups = new Set(changes.map((change) => change.target.closest('.spring-group')).filter(Boolean));
      groups.forEach((group) => syncPill(group, true));
    });
    $$('.spring-group').forEach((group) => {
      syncPill(group, false);
      pillObserver.observe(group);
      selectionObserver.observe(group, {
        attributes: true,
        subtree: true,
        attributeFilter: ['aria-selected', 'aria-pressed'],
      });
    });
    document.addEventListener('click', (event) => {
      const group = event.target.closest('.spring-group');
      if (group) queueMicrotask(() => syncPill(group, true));
    });
    document.fonts?.ready.then(() => {
      syncPills(false);
      moveNav(false);
    });
  }

  const iconMotions = new WeakMap();
  function animateIcon(button, pressed = false) {
    if (!state.motion || !preferences.liquid) return;
    const icon = $('svg.icon', button);
    if (!icon) return;
    const href = $('use', icon)?.getAttribute('href') || '';
    iconMotions.get(icon)?.cancel();
    let frames;
    if (pressed)
      frames = [
        { transform: 'scale(.72)' },
        { transform: 'scale(1.16)', offset: 0.56 },
        { transform: 'scale(.97)', offset: 0.8 },
        { transform: 'none' },
      ];
    else if (/settings|replay|sun|history/.test(href))
      frames = [
        { transform: 'rotate(-13deg) scale(.9)' },
        { transform: 'rotate(396deg) scale(1.13)', offset: 0.72 },
        { transform: 'rotate(360deg)' },
      ];
    else if (/telegram|rocket|arrow/.test(href))
      frames = [
        { transform: 'translate(0,0)' },
        { transform: 'translate(4px,-5px) rotate(-10deg)', offset: 0.42 },
        { transform: 'translate(-2px,2px)', offset: 0.74 },
        { transform: 'none' },
      ];
    else if (/robot|terminal|code/.test(href))
      frames = [
        { transform: 'scaleX(1.17) scaleY(.83)' },
        { transform: 'scaleX(.88) scaleY(1.12) translateY(-3px)', offset: 0.42 },
        { transform: 'scale(1.03)', offset: 0.74 },
        { transform: 'none' },
      ];
    else
      frames = [
        { transform: 'rotate(-9deg) scale(.87)' },
        { transform: 'rotate(12deg) scale(1.1)', offset: 0.46 },
        { transform: 'rotate(-3deg)', offset: 0.8 },
        { transform: 'none' },
      ];
    const a = icon.animate(frames, {
      duration: pressed ? 520 : 680,
      easing: 'cubic-bezier(.22,1,.36,1)',
      composite: 'add',
    });
    iconMotions.set(icon, a);
    a.finished
      .catch(() => {})
      .then(() => {
        if (iconMotions.get(icon) === a) iconMotions.delete(icon);
      });
  }
  function initializeKinetics() {
    document.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'touch') return;
      const button = event.target.closest('button,a');
      if (button && !button.contains(event.relatedTarget)) animateIcon(button);
    });
    document.addEventListener('pointerdown', (event) => {
      const button = event.target.closest('button,a');
      if (!button || button.disabled) return;
      animateIcon(button, true);
      if (!state.motion || !preferences.ripple) return;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const clip = document.createElement('span');
      clip.className = 'ripple-clip';
      clip.setAttribute('aria-hidden', 'true');
      const wave = document.createElement('span');
      wave.className = 'ripple-circle';
      const diameter = Math.max(rect.width, rect.height) * 2.4;
      wave.style.setProperty('--ripple-size', diameter + 'px');
      wave.style.setProperty('--ripple-x', event.clientX - rect.left + 'px');
      wave.style.setProperty('--ripple-y', event.clientY - rect.top + 'px');
      clip.append(wave);
      if (getComputedStyle(button).position === 'static') button.style.position = 'relative';
      button.append(clip);
      const animation = wave.animate(
        [
          { transform: 'translate(-50%,-50%) scale(0)', opacity: 0.9 },
          { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 },
        ],
        { duration: 640, easing: 'cubic-bezier(.16,1,.3,1)' },
      );
      animation.finished.catch(() => {}).then(() => clip.remove());
    });
    $$('.project-card').forEach((card) =>
      card.addEventListener('pointermove', (event) => {
        if (!state.motion || event.pointerType === 'touch') return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--card-x', event.clientX - r.left + 'px');
        card.style.setProperty('--card-y', event.clientY - r.top + 'px');
      }),
    );
    $('.rail').addEventListener('pointermove', (event) => {
      if (!state.motion || event.pointerType === 'touch') return;
      $$('.rail-link,.rail-action').forEach((button) => {
        const r = button.getBoundingClientRect(),
          distance = Math.abs(event.clientX - r.left - r.width / 2),
          strength = Math.exp(-Math.pow(distance / 58, 2));
        button.style.setProperty('--dock-scale', 1 + strength * 0.23);
        button.style.setProperty('--dock-lift', -strength * 5 + 'px');
      });
    });
    $('.rail').addEventListener('pointerleave', () => {
      $$('.rail-link,.rail-action').forEach((button) => {
        button.style.setProperty('--dock-scale', '1');
        button.style.setProperty('--dock-lift', '0px');
      });
    });
  }

  let workflowTimers = [];
  function setWorkflow(step) {
    step = clamp(Number(step), 0, 2);
    const board = $('#signal-board'),
      words = [
        ['imagine', 'possibility'],
        ['build', 'product'],
        ['ship', 'experience'],
      ];
    board.dataset.step = step;
    $('#signal-function').textContent = words[step][0];
    $('#signal-return').textContent = words[step][1];
    const captions = [
      'Начинаю с вопроса: а можно удобнее?',
      'Соединяю интерфейс, логику и инструменты.',
      'Проверяю детали. Выпускаю. Улучшаю.',
    ];
    $('#workflow-number').textContent = '0' + (step + 1);
    morphRegion($('#workflow-copy'), () => ($('#workflow-copy').textContent = tr(captions[step])), {
      duration: 400,
    });
    $$('[data-workflow]').forEach((button) =>
      button.setAttribute('aria-pressed', String(Number(button.dataset.workflow) === step)),
    );
    syncPill($('.workflow-switch'), true);
    if (state.motion) {
      const core = $('.signal-core');
      core.getAnimations().forEach((a) => a.cancel());
      core.animate(
        [
          { transform: 'scale(.8) rotate(-6deg)' },
          { transform: 'scale(1.1) rotate(4deg)', offset: 0.6 },
          { transform: 'none' },
        ],
        { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)' },
      );
      $$('.signal-node').forEach((node, i) => {
        const base = getComputedStyle(node).transform;
        node.animate(
          [
            { translate: '0 0' },
            { translate: (i % 2 ? '-5px' : '5px') + ' -4px', offset: 0.55 },
            { translate: '0 0' },
          ],
          { duration: 620, delay: i * 35, easing: 'cubic-bezier(.34,1.56,.64,1)' },
        );
      });
    }
  }
  function initializeWorkflow() {
    $$('[data-workflow]').forEach((button) =>
      button.addEventListener('click', () => {
        workflowTimers.forEach(clearTimeout);
        setWorkflow(button.dataset.workflow);
      }),
    );
    $('#workflow-run').addEventListener('click', () => {
      workflowTimers.forEach(clearTimeout);
      workflowTimers = [];
      if (!state.motion) {
        setWorkflow(2);
        return;
      }
      setWorkflow(0);
      workflowTimers.push(
        setTimeout(() => setWorkflow(1), 650),
        setTimeout(() => setWorkflow(2), 1450),
      );
    });
    const board = $('#signal-board');
    board.addEventListener('pointermove', (event) => {
      if (!state.motion || event.pointerType === 'touch') return;
      const r = board.getBoundingClientRect();
      board.style.setProperty('--signal-x', event.clientX - r.left + 'px');
      board.style.setProperty('--signal-y', event.clientY - r.top + 'px');
    });
  }

  // 2D particles like the original; capped, tab-aware and optional. No WebGL.
  function createAtmosphere() {
    const canvas = $('#atmosphere-canvas');
    let ctx;
    try {
      ctx = canvas.getContext('2d');
    } catch (_) {
      return null;
    }
    if (!ctx) return null;
    let width = 0,
      height = 0,
      frame = 0,
      last = 0,
      points = [],
      pointer = { x: -999, y: -999 },
      color = [112, 0, 255],
      line = [82, 78, 150];
    function resize() {
      width = innerWidth;
      height = innerHeight;
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const amount = width < 701 ? 22 : 40;
      points = Array.from({ length: amount }, (_, i) => ({
        x: (((i * 127.37 + 21) % 997) / 997) * width,
        y: (((i * 211.31 + 75) % 991) / 991) * height,
        vx: Math.sin(i * 1.72) * 9,
        vy: Math.cos(i * 2.41) * 8,
        r: i % 4 === 0 ? 2 : 1,
      }));
    }
    function enabled() {
      return preferences.particles && preferences.background !== 'plain' && !document.hidden;
    }
    function moving() {
      return enabled() && state.motion && !state.transitioning && !document.querySelector('dialog[open]');
    }
    function draw(dt = 0) {
      ctx.clearRect(0, 0, width, height);
      if (!enabled()) return;
      color = root.dataset.theme === 'light' ? [138, 79, 255] : [112, 0, 255];
      line = root.dataset.theme === 'light' ? [138, 79, 255] : [65, 63, 112];
      points.forEach((p) => {
        if (dt) {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          const dx = p.x - pointer.x,
            dy = p.y - pointer.y,
            dist = Math.hypot(dx, dy);
          if (dist > 0 && dist < 85) {
            p.x += (dx / dist) * (85 - dist) * dt * 0.4;
            p.y += (dy / dist) * (85 - dist) * dt * 0.4;
          }
          if (p.x < -10) p.x = width + 10;
          if (p.x > width + 10) p.x = -10;
          if (p.y < -10) p.y = height + 10;
          if (p.y > height + 10) p.y = -10;
        }
        ctx.fillStyle = 'rgba(' + color.join(',') + ',.5)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      });
      for (let i = 0; i < points.length; i++)
        for (let j = i + 1; j < points.length; j++) {
          const a = points[i],
            b = points[j],
            d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < 155) {
            ctx.strokeStyle = 'rgba(' + line.join(',') + ',' + (1 - d / 155) * 0.38 + ')';
            ctx.lineWidth = 0.7;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
    }
    function tick(now) {
      frame = 0;
      if (!moving()) {
        last = 0;
        draw();
        return;
      }
      if (last && now - last < 32) {
        frame = requestAnimationFrame(tick);
        return;
      }
      const dt = last ? Math.min((now - last) / 1000, 0.06) : 0.033;
      last = now;
      draw(dt);
      frame = requestAnimationFrame(tick);
    }
    function refresh() {
      cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      draw();
      if (moving()) frame = requestAnimationFrame(tick);
    }
    window.addEventListener('resize', () => {
      resize();
      refresh();
    });
    document.addEventListener('visibilitychange', refresh);
    document.addEventListener(
      'pointermove',
      (event) => {
        if (event.pointerType !== 'touch') {
          pointer.x = event.clientX;
          pointer.y = event.clientY;
        }
      },
      { passive: true },
    );
    document.addEventListener('pointerleave', () => (pointer = { x: -999, y: -999 }));
    resize();
    refresh();
    return { refresh };
  }

  function applyPreferences(animate = false) {
    for (const key of ['ripple', 'particles', 'liquid', 'glass']) {
      root.dataset[key] = String(preferences[key]);
      const input = $('[data-preference="' + key + '"]');
      if (input) input.checked = preferences[key];
    }
    root.dataset.background = preferences.background;
    $$('[data-background]')
      .filter((e) => e.tagName === 'BUTTON')
      .forEach((button) =>
        button.setAttribute('aria-pressed', String(button.dataset.background === preferences.background)),
      );
    $('#transition-select').value = preferences.transition;
    renderer?.refresh();
    if (root.dataset.initialized === 'true') {
      syncPill($('.background-switch'), animate);
      translateScope(document.body);
    }
  }
  function setTheme(theme) {
    theme = theme === 'light' ? 'light' : 'dark';
    root.dataset.theme = theme;
    $('#theme-switch').checked = theme === 'light';
    $('[name="theme-color"]').content = theme === 'light' ? '#f5f7ff' : '#050510';
    $$('[data-theme-toggle]').forEach((button) => {
      button.setAttribute(
        'aria-label',
        tr(theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'),
      );
      $('use', button).setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    });
    renderer?.refresh();
  }
  function setMotion() {
    state.motion = !reduced.matches && storage.get('motion', 'on') !== 'off';
    root.dataset.motion = state.motion ? 'on' : 'off';
    if (!state.motion) {
      document.getAnimations?.().forEach((a) => a.cancel());
      workflowTimers.forEach(clearTimeout);
      $$('.rail-link,.rail-action').forEach((e) => {
        e.style.setProperty('--dock-scale', '1');
        e.style.setProperty('--dock-lift', '0px');
      });
    }
    $('#motion-switch').checked = state.motion;
    $('#motion-switch').disabled = reduced.matches;
    $('#motion-description').textContent = tr(
      reduced.matches ? 'Движение уменьшено в настройках твоей системы.' : 'Переходы, пружины и живые демо.',
    );
    $('#motion-status').textContent = state.motion ? 'LIVE' : 'PAUSE';
    if (root.dataset.initialized === 'true') {
      if (!state.motion) windowMotion?.finish();
      moveNav(false);
      syncPills(false);
    }
    renderer?.refresh();
    syncDemos();
  }
  function initializePreferences() {
    $$('[data-preference]').forEach((input) =>
      input.addEventListener('change', () => {
        preferences[input.dataset.preference] = input.checked;
        storage.set(input.dataset.preference, input.checked ? 'on' : 'off');
        if (input.dataset.preference === 'liquid' && !input.checked)
          $$('svg.icon').forEach((icon) => icon.getAnimations().forEach((a) => a.cancel()));
        applyPreferences();
      }),
    );
    $$('button[data-background]').forEach((button) =>
      button.addEventListener('click', () => {
        preferences.background = button.dataset.background;
        storage.set('background', preferences.background);
        applyPreferences(true);
      }),
    );
    $('#transition-select').addEventListener('change', (event) => {
      preferences.transition = event.target.value;
      storage.set('transition', preferences.transition);
    });
    $$('[data-language]').forEach((button) =>
      button.addEventListener('click', () => setLanguage(button.dataset.language)),
    );
    $('#theme-switch').addEventListener('change', (event) => {
      const theme = event.target.checked ? 'light' : 'dark';
      storage.set('theme', theme);
      setTheme(theme);
    });
    $('#motion-switch').addEventListener('change', (event) => {
      storage.set('motion', event.target.checked ? 'on' : 'off');
      setMotion();
    });
    $$('[data-theme-toggle]').forEach((button) =>
      button.addEventListener('click', () => {
        const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
        storage.set('theme', theme);
        setTheme(theme);
      }),
    );
    reduced.addEventListener('change', setMotion);
    $('#reset-settings').addEventListener('click', () => {
      Object.assign(preferences, {
        ripple: true,
        particles: true,
        liquid: true,
        glass: true,
        background: 'constellation',
        transition: 'mix',
      });
      for (const [key, value] of Object.entries(preferences))
        storage.set(key, typeof value === 'boolean' ? (value ? 'on' : 'off') : value);
      storage.set('theme', 'dark');
      storage.set('motion', 'on');
      setTheme('dark');
      setMotion();
      setLanguage('ru');
      applyPreferences();
      toast(tr('Настройки сброшены'));
    });
    applyPreferences();
  }

  // Local Anon product preview, with no audio recording/upload or server calls.
  function anonVoiceMarkup() {
    const bars = [11, 24, 17, 33, 22, 37, 15, 28, 19, 34, 22, 14, 29, 36, 18, 26, 12, 32, 22, 15, 29, 20, 10];
    return (
      '<div class="anon-voice-demo"><div class="voice-demo-label"><span>ГОЛОСОВЫЕ И КРУЖКИ</span><span>ЗАКРЫТОЕ БЕТА</span></div><div class="voice-message"><span class="voice-orb">' +
      icons('mic') +
      '</span><span class="voice-wave" aria-hidden="true">' +
      bars.map((h) => '<i style="--wave-h:' + h + 'px"></i>').join('') +
      '</span><time>0:18</time></div><div class="voice-actions"><button type="button" data-voice-mode="transcript" aria-pressed="true">' +
      icons('file') +
      '<span>Расшифровка</span></button><button type="button" data-voice-mode="summary" aria-pressed="false">' +
      icons('compress') +
      '<span>Кратко</span></button></div><div class="voice-result"><p>Нам нужен бот для канала. Пусть принимает голосовые и кружки, превращает их в текст и убирает из расшифровки повторы, чтобы можно было быстро прочитать главное.</p></div><p class="voice-hint">Пример расшифровки</p></div>'
    );
  }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-voice-mode]');
    if (!button) return;
    const demo = button.closest('.anon-voice-demo'),
      summary = button.dataset.voiceMode === 'summary';
    $$('[data-voice-mode]', demo).forEach((item) =>
      item.setAttribute('aria-pressed', String(item === button)),
    );
    morphRegion(
      $('.voice-result', demo),
      () => {
        $('.voice-result', demo).innerHTML = summary
          ? '<p><strong>' +
            tr('Коротко:') +
            '</strong> ' +
            tr('Бот для канала: голосовые и кружки → текст → сжатое содержание без повторов.') +
            '</p>'
          : '<p>' +
            tr(
              'Нам нужен бот для канала. Пусть принимает голосовые и кружки, превращает их в текст и убирает из расшифровки повторы, чтобы можно было быстро прочитать главное.',
            ) +
            '</p>';
      },
      { duration: 550 },
    );
    if (state.motion)
      $$('.voice-wave i', demo).forEach((bar, i) =>
        bar.animate(
          [
            { transform: 'scaleY(1)' },
            { transform: 'scaleY(' + (summary ? 0.35 : 0.8) + ')', offset: 0.55 },
            { transform: 'scaleY(1)' },
          ],
          { duration: 500, delay: i * 12, easing: 'cubic-bezier(.34,1.56,.64,1)' },
        ),
      );
  });

  setTheme(root.dataset.theme);
  setMotion();

  const clock = $('#local-clock');
  const timeFormatter = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  function updateClock() {
    const now = new Date();
    clock.textContent = timeFormatter.format(now);
    clock.dateTime = now.toISOString();
  }
  updateClock();
  setInterval(() => {
    if (!document.hidden) updateClock();
  }, 30000);

  let dockFrame = 0,
    dockRect = null,
    dockTarget = null,
    dockVelocity = { x: 0, y: 0 },
    dockLast = 0;
  function paintDock() {
    if (!dockRect) return;
    const speed = Math.abs(dockVelocity.x),
      stretch = state.motion && preferences.liquid ? Math.min(25, speed * 0.019) : 0;
    const w = dockRect.w + stretch,
      h = dockRect.h - Math.min(7, stretch * 0.24);
    $('#dock-liquid-path').setAttribute(
      'd',
      capsulePath(dockRect.x - stretch / 2, dockRect.y + (dockRect.h - h) / 2, w, h),
    );
  }
  function moveNav(animate = state.motion) {
    const rail = $('.rail'),
      settings = $('#settings-dialog'),
      inSettings = !!settings?.open;
    rail.classList.toggle('has-settings', inSettings);
    const active = inSettings
      ? $('.rail-action[data-dialog="settings-dialog"]')
      : $('.rail-link[aria-current="page"]');
    if (!active) return;
    $$('.rail-action').forEach((button) =>
      button.classList.toggle('is-dock-active', inSettings && button === active),
    );
    const a = active.getBoundingClientRect(),
      r = $('.dock-fluid').getBoundingClientRect();
    const target = { x: a.left - r.left, y: a.top - r.top, w: a.width, h: a.height };
    $('.dock-fluid').setAttribute('viewBox', '0 0 ' + r.width + ' ' + r.height);
    dockTarget = target;
    if (!dockRect || !animate || !state.motion) {
      cancelAnimationFrame(dockFrame);
      dockFrame = 0;
      dockLast = 0;
      dockRect = { ...target };
      dockVelocity = { x: 0, y: 0 };
      paintDock();
      return;
    }
    function tick(now) {
      dockFrame = 0;
      if (!state.motion) {
        moveNav(false);
        return;
      }
      const dt = dockLast ? Math.min((now - dockLast) / 1000, 0.035) : 1 / 60;
      dockLast = now;
      for (const axis of ['x', 'y']) {
        dockVelocity[axis] += (330 * (dockTarget[axis] - dockRect[axis]) - 24 * dockVelocity[axis]) * dt;
        dockRect[axis] += dockVelocity[axis] * dt;
      }
      dockRect.w = dockTarget.w;
      dockRect.h = dockTarget.h;
      paintDock();
      const remaining = Math.abs(dockTarget.x - dockRect.x) + Math.abs(dockTarget.y - dockRect.y),
        speed = Math.abs(dockVelocity.x) + Math.abs(dockVelocity.y);
      if (remaining > 0.035 || speed > 0.08) dockFrame = requestAnimationFrame(tick);
      else {
        dockRect = { ...dockTarget };
        dockVelocity = { x: 0, y: 0 };
        dockLast = 0;
        paintDock();
      }
    }
    if (!dockFrame) {
      dockLast = 0;
      dockFrame = requestAnimationFrame(tick);
    }
  }
  function sizeCardHitAreas() {
    $$('.feature-card').forEach((card) => card.style.setProperty('--card-width', card.clientWidth + 'px'));
  }
  const validViews = new Set(['home', 'projects', 'lab', 'store', 'partners']);
  const viewLabels = {
    home: ['01', 'Обзор', 'home'],
    projects: ['02', 'Проекты', 'grid'],
    lab: ['03', 'XLI / XGO', 'terminal'],
    store: ['04', 'Магазин', 'bag'],
    partners: ['05', 'Партнёры', 'users'],
  };
  let navigationVersion = 0,
    pendingView = 'home',
    windowMotion = null;
  function snapshotView(view) {
    const copy = view.cloneNode(true);
    copy.classList.remove('view');
    copy.classList.add('window-snapshot');
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    [copy, ...copy.querySelectorAll('*')].forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (attribute.name === 'id' || attribute.name.startsWith('data-') || attribute.name === 'name')
          element.removeAttribute(attribute.name);
      });
    });
    $$('.ripple-clip', copy).forEach((element) => element.remove());
    return copy;
  }
  function switchView(view, { history = true, focus = false, animate = true, source = null } = {}) {
    if (!validViews.has(view) || view === pendingView) return;
    windowMotion?.finish();
    pendingView = view;
    const version = ++navigationVersion;
    const stage = $('#view-stage'),
      previous = $('#' + state.view),
      before = previous.getBoundingClientRect();
    const animated = animate && state.motion && before.width > 0,
      snapshot = animated ? snapshotView(previous) : null;
    const order = [...validViews];
    const direction = Math.sign(order.indexOf(view) - order.indexOf(state.view)) || 1;
    state.transitioning = animated;
    state.view = view;
    $$('.view').forEach((section) => (section.hidden = section.id !== view));
    $$('[data-view]').forEach((link) => {
      if (link.dataset.view === view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    const label = viewLabels[view];
    $('#view-label').textContent = tr(label[1]);
    $('#view-number').textContent = label[0] + ' / PERSONAL SPACE';
    $('#view-path-icon').setAttribute('href', '#i-' + label[2]);
    if (history && location.hash !== '#' + view) window.history.pushState(null, '', '#' + view);
    moveNav();
    sizeCardHitAreas();
    syncPills(false);
    renderer?.refresh();
    syncDemos();
    const incoming = $('#' + view),
      after = incoming.getBoundingClientRect();
    if (focus) {
      const heading =
        view === 'home' ? $('#hero-title') : view === 'lab' ? $('#lab-page-title') : $('#' + view + '-title');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      const top = Math.max(0, $('.shell').getBoundingClientRect().top + scrollY - 12);
      if (scrollY > top + 65) scrollTo({ top, behavior: 'instant' });
    }
    if (!animated) {
      state.transitioning = false;
      renderer?.refresh();
      syncDemos();
      return;
    }
    const effect = chooseEffect(),
      bounds = stage.getBoundingClientRect(),
      sourceBox = source?.getBoundingClientRect?.();
    const origin = {
      x: sourceBox
        ? clamp(sourceBox.left + sourceBox.width / 2 - bounds.left, 35, after.width - 35)
        : after.width * 0.5,
      y: Math.min(after.height * 0.55, Math.max(80, innerHeight - bounds.top - 100)),
    };
    incoming.dataset.transitionEffect = effect;
    Object.assign(snapshot.style, { width: before.width + 'px', height: before.height + 'px' });
    stage.append(snapshot);
    stage.classList.add('is-window-morphing');
    stage.setAttribute('aria-busy', 'true');
    incoming.classList.add('is-window-entering');
    const start = performance.now(),
      duration = isDesktopMotion(effect)
        ? 460
        : effect === 'cascade'
          ? 790
          : effect === 'shutters'
            ? 740
            : 700;
    let frame = 0,
      done = false,
      elapsed = 0,
      last = start;
    const record = {
      finish() {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        snapshot.remove();
        stage.classList.remove('is-window-morphing');
        stage.removeAttribute('aria-busy');
        stage.style.removeProperty('height');
        incoming.classList.remove('is-window-entering');
        incoming.style.removeProperty('clip-path');
        incoming.style.removeProperty('transform');
        if (version === navigationVersion) {
          state.transitioning = false;
          windowMotion = null;
          renderer?.refresh();
          syncPills(false);
          syncDemos();
        }
      },
    };
    windowMotion = record;
    function tick(now) {
      if (done) return;
      elapsed += Math.min(120, Math.max(0, now - last));
      last = now;
      const t = state.motion ? clamp(elapsed / duration, 0, 1) : 1;
      stage.style.height = lerp(before.height, after.height, easeOut(t)) + 'px';
      incoming.style.clipPath = cssPath(
        surfaceMask(effect, after.width, after.height, t, { ...origin, direction }),
      );
      incoming.style.transform = isDesktopMotion(effect)
        ? desktopTransform(effect, after.width, t, direction)
        : effect === 'cascade'
          ? 'translateY(' + 12 * (1 - easeOut(t)) + 'px)'
          : effect === 'liquid'
            ? 'translateY(' + 7 * (1 - spring(t)) + 'px)'
            : 'none';
      if (t < 1) frame = requestAnimationFrame(tick);
      else record.finish();
    }
    tick(start);
  }
  $$('[data-view]').forEach((link) =>
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      switchView(link.dataset.view, { focus: true, source: link });
    }),
  );
  window.addEventListener('hashchange', () =>
    switchView(location.hash.slice(1) || 'home', { history: false, focus: true }),
  );
  function initialHash() {
    const view = location.hash.slice(1);
    if (validViews.has(view)) switchView(view, { history: false, animate: false });
  }
  initialHash();
  if (document.fonts) document.fonts.ready.then(() => moveNav(false));
  let workspaceWidth = $('.workspace').clientWidth;
  new ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    if (Math.abs(width - workspaceWidth) > 0.5) {
      workspaceWidth = width;
      windowMotion?.finish();
      moveNav(false);
      sizeCardHitAreas();
      syncPills(false);
    }
  }).observe($('.workspace'));
  moveNav(false);
  sizeCardHitAreas();

  // FLIP rearrangement: surviving tiles move into place, new tiles unfold instead of fading.
  const filterButtons = $$('[data-filter]'),
    tileMotions = new WeakMap();
  filterButtons.forEach((button) =>
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-pressed') === 'true') return;
      const category = button.dataset.filter,
        cards = $$('.project-card', $('#projects'));
      const before = new Map(
        cards.filter((card) => !card.hidden).map((card) => [card, card.getBoundingClientRect()]),
      );
      cards.forEach((card) => {
        tileMotions.get(card)?.cancel();
        card.style.removeProperty('will-change');
      });
      filterButtons.forEach((filter) => filter.setAttribute('aria-pressed', String(filter === button)));
      cards.forEach((card) => (card.hidden = category !== 'all' && card.dataset.category !== category));
      let index = 0;
      cards.forEach((card) => {
        if (card.hidden) return;
        if (state.motion) {
          const old = before.get(card),
            box = card.getBoundingClientRect(),
            full = cssPath(materialPath(0, 0, box.width, box.height, 27, 0));
          const seed = cssPath(
            materialPath(box.width * 0.22, box.height * 0.26, box.width * 0.56, box.height * 0.48, 30, 0.35),
          );
          card.style.willChange = 'transform,clip-path';
          const animation = card.animate(
            [
              {
                transform: old
                  ? 'translate(' + (old.left - box.left) + 'px,' + (old.top - box.top) + 'px)'
                  : 'none',
                clipPath: old ? full : seed,
              },
              {
                transform: 'none',
                clipPath: cssPath(materialPath(0, 0, box.width, box.height, 36, 0.38)),
                offset: 0.68,
              },
              { transform: 'none', clipPath: full },
            ],
            {
              duration: 510,
              delay: old ? 0 : index * 30,
              easing: 'cubic-bezier(.22,1,.36,1)',
              fill: 'backwards',
            },
          );
          tileMotions.set(card, animation);
          animation.finished
            .catch(() => {})
            .then(() => {
              if (tileMotions.get(card) === animation) {
                tileMotions.delete(card);
                card.style.removeProperty('will-change');
              }
            });
        }
        index++;
      });
      $('#filter-status').textContent = 'Показано проектов: ' + index + '.';
    }),
  );

  // Native keyboard semantics, reversible animated disclosure geometry.
  const disclosureMotions = new WeakMap();
  document.addEventListener('click', (event) => {
    const summary = event.target.closest('.detail-extra summary');
    if (!summary) return;
    const details = summary.closest('details'),
      previous = disclosureMotions.get(details);
    const opening = previous ? !previous.open : !details.open,
      before = details.getBoundingClientRect();
    event.preventDefault();
    previous?.animation.cancel();
    details.style.removeProperty('height');
    details.style.removeProperty('overflow');
    details.open = opening;
    if (!state.motion) {
      disclosureMotions.delete(details);
      return;
    }
    const after = details.getBoundingClientRect();
    details.open = true;
    details.style.overflow = 'hidden';
    const animation = details.animate(
      [
        {
          height: before.height + 'px',
          clipPath: cssPath(materialPath(0, 0, before.width, before.height, 18, 0)),
        },
        {
          height: after.height + 'px',
          clipPath: cssPath(materialPath(0, 0, after.width, after.height, 18, 0)),
        },
      ],
      { duration: opening ? 420 : 320, easing: 'cubic-bezier(.22,1,.36,1)' },
    );
    const record = { animation, open: opening };
    disclosureMotions.set(details, record);
    animation.finished
      .catch(() => {})
      .then(() => {
        if (disclosureMotions.get(details) !== record) return;
        details.open = opening;
        details.style.removeProperty('height');
        details.style.removeProperty('overflow');
        disclosureMotions.delete(details);
      });
  });

  // Native top-layer dialogs keep focus/Escape; their actual geometry morphs from the source.
  const dialogOpeners = new WeakMap(),
    dialogSources = new WeakMap(),
    dialogMotions = new WeakMap();
  function sourceForWindow(opener) {
    const candidate =
      opener?.closest?.(
        '.bio-island,.signal-node,.feature-card,.project-card,.store-card,.partner-card,.preview-window',
      ) || opener;
    if (candidate?.getBoundingClientRect) {
      const r = candidate.getBoundingClientRect();
      if (
        r.width &&
        r.height &&
        r.bottom > 5 &&
        r.top < innerHeight - 5 &&
        r.right > 0 &&
        r.left < innerWidth
      )
        return candidate;
    }
    return $('.rail-link[aria-current="page"]') || $('.rail');
  }
  function boxOf(element) {
    const r = element.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  function cloneWindowSource(source, box) {
    const ghost = document.createElement('div');
    ghost.className = 'morph-card-copy';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    const copy = source.cloneNode(true);
    [copy, ...copy.querySelectorAll('*')].forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (
          attribute.name === 'id' ||
          attribute.name === 'name' ||
          attribute.name === 'tabindex' ||
          attribute.name.startsWith('data-')
        )
          element.removeAttribute(attribute.name);
      });
    });
    Object.assign(copy.style, {
      width: box.w + 'px',
      height: box.h + 'px',
      minWidth: '0',
      maxWidth: 'none',
      minHeight: '0',
      maxHeight: 'none',
      position: 'relative',
      inset: 'auto',
      margin: '0',
      flex: 'none',
    });
    ghost.append(copy);
    return ghost;
  }
  function morphWindow(dialog, from, to, opening, source) {
    dialogMotions.get(dialog)?.cancel();
    if (!state.motion) return Promise.resolve(true);
    return new Promise((resolve) => {
      const oldStyle = dialog.dataset.restStyle ?? dialog.getAttribute('style') ?? '';
      dialog.dataset.restStyle = oldStyle;
      const effect = opening
        ? chooseEffect(dialog.dataset.windowStyle === 'sheet' ? 'cascade' : undefined)
        : dialog.dataset.windowEffect || 'liquid';
      dialog.dataset.windowEffect = effect;
      const sourceBox = boxOf(source),
        sourceRadius = parseFloat(getComputedStyle(source).borderTopLeftRadius) || 28;
      const startPhase = opening ? 0 : (dialog._shapeProgress ?? 1),
        contentStart = opening ? 0 : Number(dialog.style.getPropertyValue('--content-visibility') || 1),
        ghostStart = opening ? 1 : Number(dialog.style.getPropertyValue('--ghost-visibility') || 0);
      const ghost = cloneWindowSource(source, sourceBox);
      $('.morph-card-copy', dialog)?.remove();
      dialog.append(ghost);
      dialog.classList.add('is-morphing');
      dialog.dataset.morphPhase = opening ? 'opening' : 'closing';
      dialog.style.setProperty('--target-content-width', Math.max(1, (opening ? to.w : from.w) - 2) + 'px');
      let frame = 0,
        settled = false,
        elapsed = 0,
        last = performance.now();
      const duration = opening
          ? isDesktopMotion(effect)
            ? 470
            : effect === 'cascade'
              ? 780
              : effect === 'shutters'
                ? 740
                : 690
          : 340,
        start = performance.now();
      const record = {
        finish() {
          if (!settled) {
            cancelAnimationFrame(frame);
            tick(start + duration, true);
          }
        },
        cancel() {
          if (settled) return;
          settled = true;
          cancelAnimationFrame(frame);
          ghost.remove();
          resolve(false);
        },
      };
      dialogMotions.set(dialog, record);
      function tick(now, force = false) {
        if (settled) return;
        elapsed += Math.min(120, Math.max(0, now - last));
        last = now;
        const t = force || !state.motion ? 1 : clamp(elapsed / duration, 0, 1);
        const position = opening ? easeOut(t) : smooth(t),
          phase = opening ? t : lerp(startPhase, 0, smooth(t));
        dialog._shapeProgress = phase;
        let wide = opening ? clamp(spring(t), 0, 1.022) : smooth(t),
          tall = opening ? smooth(t) : smooth(t);
        if (effect === 'iris') {
          wide = opening ? smooth(t) : smooth(t);
          tall = wide;
        }
        if (effect === 'shutters') {
          wide = opening ? easeOut(t) : smooth(t);
          tall = opening ? clamp(spring(t), 0, 1.01) : smooth(t);
        }
        if (effect === 'cascade') {
          tall = opening ? easeOut(smooth(t)) : smooth(t);
        }
        const x = lerp(from.x, to.x, position),
          y = lerp(from.y, to.y, position),
          w = lerp(from.w, to.w, wide),
          h = lerp(from.h, to.h, tall);
        Object.assign(dialog.style, {
          left: x + 'px',
          top: y + 'px',
          right: 'auto',
          bottom: 'auto',
          width: w + 'px',
          height: h + 'px',
        });
        if (effect === 'liquid')
          dialog.style.clipPath = cssPath(
            materialPath(
              0,
              0,
              w,
              h,
              lerp(sourceRadius, 30, phase) + Math.sin(Math.PI * phase) * Math.min(54, Math.min(w, h) * 0.12),
              Math.sin(Math.PI * phase) * 0.7,
            ),
          );
        else if (effect === 'iris')
          dialog.style.clipPath = cssPath(
            materialPath(0, 0, w, h, lerp(Math.min(w, h) * 0.46, 29, smooth(phase)), 0),
          );
        else dialog.style.clipPath = cssPath(surfaceMask(effect, w, h, 0.18 + phase * 0.82));
        const content = opening
          ? smooth(clamp((t - 0.18) / 0.54, 0, 1))
          : contentStart * (1 - smooth(clamp(t / 0.52, 0, 1)));
        const copied = opening
          ? 1 - smooth(clamp(t / 0.39, 0, 1))
          : lerp(ghostStart, 1, smooth(clamp((t - 0.35) / 0.65, 0, 1)));
        dialog.style.setProperty('--content-visibility', String(content));
        dialog.style.setProperty('--ghost-visibility', String(copied));
        ghost.style.transform =
          'scale(' + w / Math.max(1, sourceBox.w) + ',' + h / Math.max(1, sourceBox.h) + ')';
        if (t < 1) {
          frame = requestAnimationFrame(tick);
          return;
        }
        settled = true;
        ghost.remove();
        dialog.classList.remove('is-morphing');
        dialog.style.cssText = oldStyle;
        delete dialog.dataset.restStyle;
        delete dialog._shapeProgress;
        dialog.dataset.morphPhase = 'rest';
        dialogMotions.delete(dialog);
        resolve(true);
      }
      tick(start);
    });
  }
  function openDialog(dialog, opener = document.activeElement) {
    if (!dialog || dialog.open) return;
    const source = sourceForWindow(opener);
    dialogOpeners.set(dialog, opener);
    dialogSources.set(dialog, source);
    dialog.classList.remove('is-closing');
    dialog.showModal();
    dialog.scrollTop = 0;
    moveNav();
    syncPills(false);
    translateScope(dialog);
    renderer?.refresh();
    syncDemos();
    const target = boxOf(dialog),
      origin = boxOf(source);
    if (!state.motion) {
      dialog.dataset.morphPhase = 'rest';
      return;
    }
    morphWindow(dialog, origin, target, true, source).then((finished) => {
      if (finished && dialog.open) {
        dialog.scrollTop = 0;
        syncDemos();
      }
    });
  }
  async function closeDialog(dialog) {
    if (!dialog?.open) return;
    if (dialog.classList.contains('is-closing')) return dialog._closingPromise;
    const opener = dialogOpeners.get(dialog),
      source = sourceForWindow(dialogSources.get(dialog) || opener);
    const current = boxOf(dialog);
    dialog.classList.add('is-closing');
    const finish = async () => {
      if (state.motion) await morphWindow(dialog, current, boxOf(source), false, source);
      dialogMotions.get(dialog)?.cancel();
      dialog.classList.remove('is-morphing', 'is-closing');
      dialog.dataset.morphPhase = 'rest';
      if (dialog.dataset.restStyle !== undefined) {
        dialog.style.cssText = dialog.dataset.restStyle;
        delete dialog.dataset.restStyle;
      }
      $('.morph-card-copy', dialog)?.remove();
      dialog.close();
      moveNav();
      renderer?.refresh();
      syncDemos();
      if (opener?.isConnected && !opener.closest('[hidden]')) opener.focus({ preventScroll: true });
      if (state.motion && source?.isConnected)
        source.animate([{ filter: 'brightness(1.08)' }, { filter: 'brightness(1)' }], {
          duration: 350,
          easing: 'ease-out',
        });
    };
    dialog._closingPromise = finish();
    return dialog._closingPromise;
  }
  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeDialog(dialog);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        closeDialog(dialog);
    });
    dialog.addEventListener('close', () => {
      destroyDemos(dialog);
      moveNav();
      renderer?.refresh();
      syncDemos();
    });
  });
  document.addEventListener('click', (event) => {
    const close = event.target.closest('[data-close]');
    if (close) closeDialog(close.closest('dialog'));
    const trigger = event.target.closest('[data-dialog]');
    if (trigger) openDialog(document.getElementById(trigger.dataset.dialog), trigger);
    const contact = event.target.closest('[data-contact]');
    if (contact && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      openDialog($('#contact-dialog'), contact);
    }
    const project = event.target.closest('[data-project]');
    if (project) openProject(project.dataset.project, project);
    const lab = event.target.closest('[data-lab]');
    if (lab && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      openLab(lab.dataset.lab, lab);
    }
  });
  function openProject(id, opener = document.activeElement) {
    const project = projects[id];
    if (!project) return;
    const dialog = $('#detail-dialog');
    destroyDemos(dialog);
    dialog.classList.toggle('project-dialog-rich', id === 'xli' || id === 'xgo');
    $('#detail-content').innerHTML = `
          <p class="eyebrow">${escapeHTML(project.label)}</p>
          <h2 id="detail-title">${escapeHTML(project.title)}</h2>
          <p class="dialog-intro">${escapeHTML(project.intro)}</p>
          <div class="dialog-tags">${project.tags.map((tag) => '<span>' + escapeHTML(tag) + '</span>').join('')}</div>
          ${project.image ? '<img class="detail-image" src="' + project.image + '" alt="Интерфейс / графика ' + escapeHTML(project.title) + '">' : ''}
          <ul class="detail-features info-grid">${project.features.map((feature, index) => '<li>' + icons(['code', 'nodes', 'shield', 'file'][index % 4]) + '<span>' + escapeHTML(feature) + '</span></li>').join('')}</ul>
          <div class="info-callout">${icons('info')}<p class="dialog-note">${escapeHTML(project.note)}</p></div>
          ${id === 'xli' ? terminalFrame('modal-cli', 'bugfix') : id === 'xgo' ? chatFrame('modal-chat') : ''}
          ${projectExtra(id)}
          <div class="dialog-actions">${id === 'xli' || id === 'xgo' ? '<a class="solid-button" href="#lab" data-lab="' + id + '">' + (id === 'xli' ? 'Терминалы и 14 подсистем' : 'Чат, инструменты и память') + arrow + '</a>' : ''}<a class="${id === 'xli' || id === 'xgo' ? 'outline-button' : 'solid-button'}" href="${project.url}" target="_blank" rel="noopener noreferrer">${escapeHTML(project.action)}${arrow}</a><button class="outline-button" type="button" data-close>Закрыть</button></div>`;
    mountDemos(dialog);
    openDialog(dialog, opener);
  }

  window.addEventListener('resize', () => {
    $$('dialog[open]').forEach((dialog) => dialogMotions.get(dialog)?.finish());
    windowMotion?.finish();
  });

  let toastTimer;
  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
  }
  $('#copy-contact').addEventListener('click', async () => {
    let copied = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText('@Aubeig');
        copied = true;
      }
    } catch (_) {
      /* Use the selectable fallback below. */
    }
    if (!copied) {
      const input = document.createElement('textarea');
      input.value = '@Aubeig';
      input.setAttribute('aria-label', 'Контакт для копирования');
      input.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
      $('#contact-dialog').append(input);
      input.focus();
      input.select();
      try {
        copied = document.execCommand('copy');
      } catch (_) {}
      input.remove();
      $('#copy-contact').focus({ preventScroll: true });
    }
    const message = copied ? 'Контакт @Aubeig скопирован' : 'Выдели @Aubeig слева и скопируй вручную';
    $('#copy-label').textContent = copied ? 'Скопировано ✓' : 'Скопируй @Aubeig вручную';
    $('#copy-status').textContent = message;
    toast(message);
    setTimeout(() => {
      $('#copy-label').textContent = 'Скопировать контакт';
    }, 3000);
  });

  root.dataset.initialized = 'true';
  initializeLab();
  initializePills();
  initializeWorkflow();
  initializeKinetics();
  initializePreferences();
  initializeLanguage();
  try {
    renderer = createAtmosphere();
  } catch (_) {
    /* The static CSS atmosphere remains available. */
  }
  moveNav(false);
  sizeCardHitAreas();
})();
