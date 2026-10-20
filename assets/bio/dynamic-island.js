const COPY = {
  ru: {
    opened: 'Открыт к идеям',
    playing: 'СЕЙЧАС ЗВУЧИТ',
    ready: 'ПАУЗА',
    noTrack: 'Добавь свою музыку',
    localOnly: 'Файл воспроизводится только в этом браузере',
    addTrackPrompt: 'Нажми «＋ Трек», чтобы добавить музыку',
    weatherChoose: 'Выбери город или разреши геолокацию',
    noLyrics: 'Синхронный текст появится здесь',
    noTrackLyrics: 'Сначала выбери трек',
    lyricsLoaded: 'Текст найден — выбери подходящий вариант',
    lyricsEmpty: 'Подходящий текст не найден',
    lyricsFailed: 'Поиск текста временно недоступен',
    lyricsSearching: 'Ищем текст песни…',
    lyricsPlain: 'Для этой песни есть текст без синхронизации',
    weatherNeedLocation: 'Разреши геолокацию в браузере или укажи город вручную',
    weatherLocating: 'Определяю местоположение…',
    weatherLoading: 'Получаю прогноз…',
    weatherDenied: 'Нет доступа к геолокации. Можно выбрать город вручную.',
    weatherUnavailable: 'Не удалось получить прогноз. Попробуй ещё раз.',
    weatherCityMissing: 'Введи название города',
    weatherCityNotFound: 'Город не найден',
    feels: 'ощущается',
    humidity: 'влажность',
    wind: 'ветер',
    weatherCodes: [
      'Ясно',
      'Преимущественно ясно',
      'Переменная облачность',
      'Пасмурно',
      'Туман',
      'Морось',
      'Дождь',
      'Снег',
      'Ливень / снег',
      'Гроза',
    ],
    copied: 'Контакт скопирован',
    copyFailed: 'Не удалось скопировать контакт',
  },
  en: {
    opened: 'Open to ideas',
    playing: 'NOW PLAYING',
    ready: 'PAUSED',
    noTrack: 'Add your music',
    localOnly: 'Audio stays in this browser',
    addTrackPrompt: 'Press “＋ Track” to add music',
    weatherChoose: 'Choose a city or allow location',
    noLyrics: 'Synced lyrics appear here',
    noTrackLyrics: 'Choose a track first',
    lyricsLoaded: 'Lyrics found — choose a match',
    lyricsEmpty: 'No matching lyrics found',
    lyricsFailed: 'Lyrics search is temporarily unavailable',
    lyricsSearching: 'Searching for lyrics…',
    lyricsPlain: 'Plain lyrics are available, without timestamps',
    weatherNeedLocation: 'Allow browser location or enter a city manually',
    weatherLocating: 'Finding your location…',
    weatherLoading: 'Getting the forecast…',
    weatherDenied: 'Location access unavailable. Choose a city instead.',
    weatherUnavailable: 'Could not get the forecast. Please retry.',
    weatherCityMissing: 'Enter a city name',
    weatherCityNotFound: 'City not found',
    feels: 'feels like',
    humidity: 'humidity',
    wind: 'wind',
    weatherCodes: [
      'Clear',
      'Mostly clear',
      'Partly cloudy',
      'Overcast',
      'Fog',
      'Drizzle',
      'Rain',
      'Snow',
      'Showers / snow',
      'Thunderstorm',
    ],
    copied: 'Contact copied',
    copyFailed: 'Could not copy the contact',
  },
};

const byId = (id) => document.getElementById(id);
const locale = () => (document.documentElement.lang === 'en' ? 'en' : 'ru');
const say = (key) => COPY[locale()][key] || COPY.ru[key] || key;
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};
const safeStorage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Browser storage is optional. */
    }
  },
};

export function parseLrc(text) {
  const entries = [];
  const timestamp = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of text.split(/\r?\n/)) {
    const matches = [...line.matchAll(timestamp)];
    const lyric = line.replace(timestamp, '').trim();
    if (!lyric) continue;
    for (const match of matches) {
      const fraction = match[3] || '0';
      const milliseconds =
        fraction.length === 1
          ? Number(fraction) * 100
          : fraction.length === 2
            ? Number(fraction) * 10
            : Number(fraction);
      entries.push({ time: Number(match[1]) * 60 + Number(match[2]) + milliseconds / 1000, text: lyric });
    }
  }
  return entries.sort((a, b) => a.time - b.time);
}

const weatherDescription = (code) => {
  const group =
    code === 0
      ? 0
      : code === 1
        ? 1
        : code === 2
          ? 2
          : code === 3
            ? 3
            : code <= 48
              ? 4
              : code <= 57
                ? 5
                : code <= 67
                  ? 6
                  : code <= 77
                    ? 7
                    : code <= 86
                      ? 8
                      : 9;
  return COPY[locale()].weatherCodes[group];
};

export function initializeDynamicIsland(expandingIsland) {
  const island = byId('bio-island');
  const trigger = byId('bio-island-trigger');
  if (!island || !trigger) return;

  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = Number(safeStorage.get('bio.island.volume') ?? 0.8);
  const volume = byId('island-volume');
  volume.value = String(audio.volume);
  const tracks = [];
  const waveform = [...document.querySelectorAll('#island-waveform i, .island-mini-bars i')];
  let trackIndex = -1;
  let objectUrl = '';
  let lyrics = [];
  let clockTimer = 0;
  let activeWeather = null;

  function updateIslandCopy() {
    const track = tracks[trackIndex];
    const title = track ? track.file.name.replace(/\.[^.]+$/, '') : say('opened');
    const action =
      island.dataset.open === 'true'
        ? locale() === 'en'
          ? 'Close'
          : 'Закрыть'
        : locale() === 'en'
          ? 'Open'
          : 'Открыть';
    trigger.setAttribute(
      'aria-label',
      `${action} ${locale() === 'en' ? 'quick actions' : 'быстрые действия'}`,
    );
    byId('bio-island-status').textContent = title;
    byId('bio-island-status').title = track?.file.name || '';
    island.dataset.playing = String(Boolean(track && !audio.paused));
    byId('island-track-title').textContent = track ? title : say('noTrack');
    byId('island-track-subtitle').textContent = track ? say('localOnly') : say('addTrackPrompt');
  }
  function paintLyrics() {
    if (!lyrics.length) return;
    let index = 0;
    while (index + 1 < lyrics.length && lyrics[index + 1].time <= audio.currentTime) index++;
    const line = lyrics[index]?.text || say('noLyrics');
    if (byId('island-lyrics').textContent !== line) {
      byId('island-lyrics').textContent = line;
      const motionAllowed =
        document.documentElement.dataset.motion !== 'off' &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (motionAllowed)
        byId('island-lyrics').animate?.(
          [
            { opacity: 0.35, transform: 'translateY(3px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 220, easing: 'ease-out' },
        );
    }
  }
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = tracks[trackIndex];
    try {
      if (track && 'MediaMetadata' in window)
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.file.name.replace(/\.[^.]+$/, ''),
          artist: 'Aubeig',
        });
      navigator.mediaSession.playbackState = !track ? 'none' : audio.paused ? 'paused' : 'playing';
      for (const [action, handler] of Object.entries({
        play: () => audio.play().catch(() => {}),
        pause: () => audio.pause(),
        previoustrack: () => tracks.length && setTrack(trackIndex - 1),
        nexttrack: () => tracks.length && setTrack(trackIndex + 1),
        seekto: ({ seekTime }) => {
          if (Number.isFinite(seekTime)) audio.currentTime = seekTime;
        },
      })) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {
          /* Unsupported action. */
        }
      }
      if (Number.isFinite(audio.duration) && audio.duration > 0)
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        });
    } catch {
      /* Media Session is an enhancement only. */
    }
  }
  function setTrack(index, autoplay = true) {
    if (!tracks.length) return;
    trackIndex = (index + tracks.length) % tracks.length;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    const track = tracks[trackIndex];
    objectUrl = URL.createObjectURL(track.file);
    audio.src = objectUrl;
    lyrics = track.lyrics || [];
    byId('island-lyrics').textContent = lyrics[0]?.text || say('noLyrics');
    byId('island-lyrics-note').textContent = lyrics.length ? say('lyricsLoaded') : say('noTrackLyrics');
    byId('island-lyrics-status').textContent = '';
    byId('island-lyrics-results').replaceChildren();
    updateIslandCopy();
    updateMediaSession();
    if (autoplay)
      audio.play().catch(() => {
        byId('island-lyrics-status').textContent = say('localOnly');
      });
  }
  byId('island-audio-input').addEventListener('change', (event) => {
    const accepted = [...(event.target.files || [])].filter(
      (file) => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac|aiff?)$/i.test(file.name),
    );
    const first = tracks.length;
    tracks.push(...accepted.map((file) => ({ file, lyrics: [] })));
    if (trackIndex < 0 && accepted.length) setTrack(first, false);
    event.target.value = '';
  });
  byId('island-play').addEventListener('click', () => {
    if (trackIndex < 0) {
      byId('island-audio-input').click();
      return;
    }
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
  });
  byId('island-prev').addEventListener('click', () => setTrack(trackIndex - 1));
  byId('island-next').addEventListener('click', () => setTrack(trackIndex + 1));
  audio.addEventListener('play', () => {
    byId('island-play').textContent = 'Ⅱ';
    byId('island-play').setAttribute('aria-label', locale() === 'en' ? 'Pause' : 'Пауза');
    updateIslandCopy();
    updateMediaSession();
  });
  audio.addEventListener('pause', () => {
    byId('island-play').textContent = '▶';
    byId('island-play').setAttribute('aria-label', locale() === 'en' ? 'Play' : 'Воспроизвести');
    updateIslandCopy();
    updateMediaSession();
  });
  audio.addEventListener('ended', () => tracks.length > 1 && setTrack(trackIndex + 1));
  audio.addEventListener('timeupdate', () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    byId('island-current-time').textContent = formatTime(audio.currentTime);
    byId('island-duration').textContent = formatTime(duration);
    if (duration) byId('island-seek').value = String(Math.round((audio.currentTime / duration) * 1000));
    paintLyrics();
    updateMediaSession();
  });
  byId('island-seek').addEventListener('input', (event) => {
    if (Number.isFinite(audio.duration))
      audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  });
  volume.addEventListener('input', () => {
    audio.volume = Number(volume.value);
    safeStorage.set('bio.island.volume', String(audio.volume));
  });

  byId('island-lyrics-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (trackIndex < 0) {
      byId('island-lyrics-status').textContent = say('noTrackLyrics');
      return;
    }
    lyrics = parseLrc(await file.text());
    tracks[trackIndex].lyrics = lyrics;
    byId('island-lyrics').textContent = lyrics[0]?.text || say('noLyrics');
    byId('island-lyrics-note').textContent = lyrics.length ? say('lyricsLoaded') : say('noLyrics');
    paintLyrics();
  });
  byId('island-lyrics-search-button').addEventListener('click', async () => {
    if (trackIndex < 0) {
      byId('island-lyrics-status').textContent = say('noTrackLyrics');
      return;
    }
    const query =
      byId('island-lyrics-query').value.trim() ||
      tracks[trackIndex].file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
    if (!query) return;
    const button = byId('island-lyrics-search-button');
    button.disabled = true;
    byId('island-lyrics-status').textContent = say('lyricsSearching');
    const results = byId('island-lyrics-results');
    results.replaceChildren();
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(12_000),
        mode: 'cors',
      });
      if (!response.ok) throw new Error('LRCLIB request failed');
      const matches = await response.json();
      const usable = Array.isArray(matches)
        ? matches.filter((item) => item.syncedLyrics || item.plainLyrics).slice(0, 4)
        : [];
      if (!usable.length) {
        byId('island-lyrics-status').textContent = say('lyricsEmpty');
        return;
      }
      byId('island-lyrics-status').textContent = say('lyricsLoaded');
      for (const item of usable) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.textContent = `${item.trackName || query} — ${item.artistName || ''}`;
        choice.addEventListener('click', () => {
          lyrics = parseLrc(item.syncedLyrics || '');
          if (!lyrics.length && item.plainLyrics) lyrics = [{ time: 0, text: item.plainLyrics }];
          tracks[trackIndex].lyrics = lyrics;
          byId('island-lyrics').textContent = lyrics[0]?.text || say('noLyrics');
          byId('island-lyrics-note').textContent = item.syncedLyrics
            ? say('lyricsLoaded')
            : say('lyricsPlain');
          byId('island-lyrics-status').textContent = '';
          results.replaceChildren();
          paintLyrics();
        });
        results.append(choice);
      }
    } catch {
      byId('island-lyrics-status').textContent = say('lyricsFailed');
    } finally {
      button.disabled = false;
    }
  });

  function setClock() {
    byId('bio-island-time').textContent = new Intl.DateTimeFormat(locale() === 'en' ? 'en-US' : 'ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  }
  function setSection() {
    const current = document.querySelector('.rail-link[aria-current="page"]');
    const labels = {
      home: { ru: 'Обзор', en: 'Overview' },
      projects: { ru: 'Проекты', en: 'Projects' },
      lab: { ru: 'XLI / XGO', en: 'XLI / XGO' },
      store: { ru: 'Магазин', en: 'Store' },
      partners: { ru: 'Партнёры', en: 'Partners' },
    };
    const key = current?.dataset.view || 'home';
    byId('bio-island-section').textContent = labels[key]?.[locale()] || labels.home[locale()];
  }
  setClock();
  setSection();
  clockTimer = setInterval(setClock, 30_000);
  window.addEventListener('hashchange', setSection);
  new MutationObserver(setSection).observe(document.querySelector('.rail-nav') || document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-current'],
  });
  new MutationObserver(() => {
    setClock();
    setSection();
    updateIslandCopy();
    const english = locale() === 'en';
    byId('island-lyrics-query').placeholder = english ? 'Artist and title' : 'Исполнитель и название';
    byId('island-weather-city-input').placeholder = english
      ? 'City, e.g. Krasnoyarsk'
      : 'Город, например Красноярск';
    if (activeWeather) {
      byId('island-weather-place').textContent =
        `${activeWeather.place} · ${weatherDescription(activeWeather.code)}`;
      byId('island-weather-extra').textContent =
        `${say('feels')} ${activeWeather.feels}° · ${activeWeather.humidity}% · ${activeWeather.wind} km/h`;
    } else byId('island-weather-place').textContent = say('weatherChoose');
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  async function showWeather(latitude, longitude, place) {
    const status = byId('island-weather-status');
    status.textContent = say('weatherLoading');
    byId('island-weather-temperature').textContent = '…';
    try {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude,
        longitude,
        current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
        timezone: 'auto',
      });
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('Weather request failed');
      const { current } = await response.json();
      if (!current) throw new Error('Weather response is empty');
      activeWeather = {
        place,
        code: current.weather_code,
        temperature: Math.round(current.temperature_2m),
        feels: Math.round(current.apparent_temperature),
        humidity: Math.round(current.relative_humidity_2m),
        wind: Math.round(current.wind_speed_10m),
      };
      byId('island-weather-temperature').textContent = `${activeWeather.temperature}°`;
      byId('island-weather-place').textContent = `${place} · ${weatherDescription(current.weather_code)}`;
      byId('island-weather-extra').textContent =
        `${say('feels')} ${activeWeather.feels}° · ${activeWeather.humidity}% · ${activeWeather.wind} km/h`;
      status.textContent = '';
      byId('island-weather-card').dataset.loaded = 'true';
    } catch {
      byId('island-weather-temperature').textContent = '—°';
      status.textContent = say('weatherUnavailable');
    }
  }
  byId('island-weather-location').addEventListener('click', () => {
    const status = byId('island-weather-status');
    if (!navigator.geolocation) {
      status.textContent = say('weatherDenied');
      return;
    }
    status.textContent = say('weatherLocating');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        showWeather(
          coords.latitude,
          coords.longitude,
          locale() === 'en' ? 'Your location' : 'Твоё местоположение',
        ),
      () => {
        status.textContent = say('weatherDenied');
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 600_000 },
    );
  });
  byId('island-weather-search').addEventListener('click', async () => {
    const query = byId('island-weather-city-input').value.trim();
    const status = byId('island-weather-status');
    if (!query) {
      status.textContent = say('weatherCityMissing');
      return;
    }
    status.textContent = say('weatherLoading');
    try {
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: query, count: '1', language: locale(), format: 'json' });
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('Geocoding failed');
      const result = await response.json();
      const city = result.results?.[0];
      if (!city) {
        status.textContent = say('weatherCityNotFound');
        return;
      }
      const place = [city.name, city.country].filter(Boolean).join(', ');
      await showWeather(city.latitude, city.longitude, place);
    } catch {
      status.textContent = say('weatherUnavailable');
    }
  });
  byId('island-weather-city-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') byId('island-weather-search').click();
  });
  byId('island-copy-contact').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('@Aubeig');
      byId('island-copy-contact').lastElementChild.textContent = say('copied');
      setTimeout(() => {
        byId('island-copy-contact').lastElementChild.textContent = '@Aubeig';
      }, 1400);
    } catch {
      byId('island-copy-contact').lastElementChild.textContent = say('copyFailed');
    }
  });
  new MutationObserver(updateIslandCopy).observe(island, {
    attributes: true,
    attributeFilter: ['data-open'],
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) expandingIsland.finish?.();
  });
  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(clockTimer);
      audio.pause();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
    { once: true },
  );
  updateIslandCopy();
}
