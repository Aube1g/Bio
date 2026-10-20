const COPY = {
  ru: {
    idle: 'Медиа · таймер · файлы',
    playing: 'СЕЙЧАС ЗВУЧИТ',
    paused: 'ПАУЗА',
    ready: 'ГОТОВ',
    noTrack: 'Добавь свою музыку',
    localOnly: 'Локальный аудиофайл',
    play: 'Воспроизвести',
    pause: 'Пауза',
    noLyrics: 'Текст песни появится здесь.',
    lyricsLoaded: 'Текст синхронизирован',
    lyricsMissing: 'Выбери аудиотрек, затем добавь .lrc',
    lyricsSearching: 'Ищу синхронный текст…',
    lyricsSearchEmpty: 'Ничего не найдено. Попробуй указать исполнителя и название.',
    lyricsSearchFailed: 'Не удалось подключиться к LRCLIB. Можно загрузить .lrc-файл.',
    lyricsPlain: 'У результата нет синхронной разметки; показан обычный текст.',
    noFiles: 'Полка пока пуста. Добавь файл или перетащи его сюда.',
    saved: 'Файл добавлен на полку',
    saveError: 'Не удалось сохранить. Возможно, в хранилище недостаточно места.',
    clearConfirm: 'Удалить все файлы с локальной полки?',
    deleted: 'Файл удалён',
    unsupported: 'Эта функция не поддерживается текущим браузером.',
    cameraDenied: 'Не удалось открыть камеру. Проверь разрешение сайта и защищённое соединение.',
    scanning: 'Наведи камеру на QR-код…',
    qrNoCode: 'QR-код не найден. Попробуй другое изображение.',
    qrFound: 'QR-код распознан',
    cameraStart: 'Открыть камеру',
    noLocation: 'Геолокация не поддерживается или недоступна.',
    locationLoading: 'Запрашиваю разрешение на геолокацию…',
    weatherLoading: 'Получаю прогноз…',
    weatherError: 'Погода сейчас недоступна. Проверь сеть и разрешение геолокации.',
    locationDenied: 'Доступ к местоположению отклонён. Его можно разрешить в настройках браузера.',
    timerDone: 'Время вышло',
    timerFinishedBody: 'Таймер завершён. Хорошая работа!',
    timerRunning: 'Таймер идёт',
    timerPaused: 'Таймер на паузе',
    timerReady: 'Выбери длительность и запускай',
    permissionGranted: 'Уведомления разрешены',
    permissionDenied: 'Уведомления запрещены в настройках браузера',
    permissionDefault: 'Разреши уведомления, чтобы получить сигнал после завершения таймера.',
    weatherCoord: 'Погода по твоим координатам',
    feels: 'Ощущается',
    humidity: 'Влажность',
    wind: 'Ветер',
    introStorage: 'Знакомство можно снова открыть в настройках острова.',
    copied: 'Скопировано',
    minutes: 'мин',
  },
  en: {
    idle: 'Media · timer · files',
    playing: 'NOW PLAYING',
    paused: 'PAUSED',
    ready: 'READY',
    noTrack: 'Add your music',
    localOnly: 'Local audio file',
    play: 'Play',
    pause: 'Pause',
    noLyrics: 'Synced lyrics will appear here.',
    lyricsLoaded: 'Lyrics synced',
    lyricsMissing: 'Choose a track, then add an .lrc file',
    lyricsSearching: 'Searching for synced lyrics…',
    lyricsSearchEmpty: 'No matches. Try the artist and track name.',
    lyricsSearchFailed: 'Could not reach LRCLIB. You can still add an .lrc file.',
    lyricsPlain: 'This result has no timestamps; showing plain lyrics.',
    noFiles: 'Your shelf is empty. Add or drop files here.',
    saved: 'File added to your shelf',
    saveError: 'Could not save the file. Browser storage may be full.',
    clearConfirm: 'Remove every file from your local shelf?',
    deleted: 'File removed',
    unsupported: 'This feature is not supported by this browser.',
    cameraDenied: 'Could not open the camera. Check site permission and secure connection.',
    scanning: 'Point the camera at a QR code…',
    qrNoCode: 'No QR code found. Try another image.',
    qrFound: 'QR code detected',
    cameraStart: 'Open camera',
    noLocation: 'Geolocation is not supported or available.',
    locationLoading: 'Requesting location permission…',
    weatherLoading: 'Getting the forecast…',
    weatherError: 'Weather is unavailable. Check your connection and location permission.',
    locationDenied: 'Location access was denied. You can allow it in browser settings.',
    timerDone: 'Time is up',
    timerFinishedBody: 'Your timer is complete. Nicely done!',
    timerRunning: 'Timer running',
    timerPaused: 'Timer paused',
    timerReady: 'Choose a duration and start',
    permissionGranted: 'Notifications allowed',
    permissionDenied: 'Notifications are blocked in browser settings',
    permissionDefault: 'Allow notifications to get an alert when the timer ends.',
    weatherCoord: 'Weather at your location',
    feels: 'Feels like',
    humidity: 'Humidity',
    wind: 'Wind',
    introStorage: 'You can replay this welcome from the island settings.',
    copied: 'Copied',
    minutes: 'min',
  },
};

const byId = (id) => document.getElementById(id);
const locale = () => (document.documentElement.lang === 'en' ? 'en' : 'ru');
const say = (key) => COPY[locale()][key] || COPY.ru[key] || key;
const setText = (id, text) => {
  const node = byId(id);
  if (node) node.textContent = text;
};
const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
};
const safeLocalStorage = {
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
      /* private mode */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  },
};

function openShelfDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open('aubeig-island-shelf', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local shelf'));
  });
}
async function shelfTransaction(mode, action) {
  const database = await openShelfDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('files', mode);
    const store = transaction.objectStore('files');
    const request = action(store);
    let result;
    if (request) {
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
    }
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error('Storage transaction aborted'));
    };
  });
}

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

export function initializeDynamicIsland(expandingIsland) {
  const element = byId('bio-island');
  const trigger = byId('bio-island-trigger');
  if (!element || !trigger) return;
  const pages = [...document.querySelectorAll('[data-island-page]')];
  const tabs = [...document.querySelectorAll('[data-island-tab]')];
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = Number(safeLocalStorage.get('bio.island.volume') || 0.8);
  byId('island-volume').value = String(audio.volume);
  let tracks = [];
  let currentTrack = -1;
  let currentObjectUrl = '';
  let loadedLyrics = [];
  let shelfFiles = [];
  const shelfThumbnailUrls = new Set();
  let audioContext;
  let analyser;
  let spectrumFrame = 0;
  let timerInterval = 0;
  let timerState = { endAt: 0, remainingMs: 300_000, running: false };
  let barcodeDetector;
  let cameraStream;
  let cameraFrame = 0;
  let scanning = false;
  let dragGesture = null;
  let gestureConsumed = false;
  let gestureReset = 0;
  const bars = [...document.querySelectorAll('#island-wave i, #island-trigger-meter i')];

  const stopCamera = () => {
    scanning = false;
    cancelAnimationFrame(cameraFrame);
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    const video = byId('island-qr-video');
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  };
  const selectTab = (name, focus = false) => {
    for (const tab of tabs) {
      const active = tab.dataset.islandTab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active && focus) tab.focus();
    }
    for (const page of pages) {
      const active = page.dataset.islandPage === name;
      page.classList.toggle('is-active', active);
      page.hidden = !active;
    }
    if (name !== 'tools') stopCamera();
    element.dataset.mode = name;
  };
  tabs.forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.islandTab)));
  tabs.forEach((tab, index) =>
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectTab(tabs[next].dataset.islandTab, true);
    }),
  );
  byId('island-close').addEventListener('click', () => expandingIsland.toggle(false));

  function setTriggerCopy() {
    const track = tracks[currentTrack];
    setText('island-trigger-title', track ? track.file.name.replace(/\.[^.]+$/, '') : 'Aubeig Island');
    setText('island-trigger-subtitle', track ? (audio.paused ? say('paused') : say('playing')) : say('idle'));
    const title = byId('island-trigger-title');
    title?.setAttribute('title', track?.file.name || 'Aubeig Island');
    element.dataset.playing = String(Boolean(track && !audio.paused));
  }
  function setTrack(index, autoplay = false) {
    if (!tracks.length) return;
    currentTrack = (index + tracks.length) % tracks.length;
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    const track = tracks[currentTrack];
    currentObjectUrl = URL.createObjectURL(track.file);
    audio.src = currentObjectUrl;
    loadedLyrics = track.lyrics || [];
    setText('island-track-title', track.file.name.replace(/\.[^.]+$/, ''));
    setText('island-track-artist', say('localOnly'));
    setText('island-lyrics-state', loadedLyrics.length ? '✓' : '＋');
    setText('island-lyrics', loadedLyrics.length ? loadedLyrics[0].text : say('noLyrics'));
    byId('island-play').textContent = '▶';
    byId('island-play').setAttribute('aria-label', say('play'));
    if (autoplay) audio.play().catch(() => setText('island-track-artist', say('localOnly')));
    setTriggerCopy();
    updateMediaSession();
  }
  function addAudio(files) {
    const accepted = [...files].filter(
      (file) => file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|opus|flac|aiff?)$/i.test(file.name),
    );
    const start = tracks.length;
    tracks.push(...accepted.map((file) => ({ file, lyrics: [] })));
    if (accepted.length && currentTrack < 0) setTrack(start, false);
    else if (accepted.length)
      setText(
        'island-track-artist',
        `${tracks.length} ${locale() === 'ru' ? 'треков в очереди' : 'tracks in queue'}`,
      );
    return accepted.length;
  }
  byId('island-audio-input').addEventListener('change', (event) => {
    const count = addAudio(event.target.files);
    if (count) selectTab('player');
    event.target.value = '';
  });
  byId('island-play').addEventListener('click', () => {
    if (currentTrack < 0) {
      byId('island-audio-input').click();
      return;
    }
    if (audio.paused) audio.play().catch(() => setText('island-track-artist', say('unsupported')));
    else audio.pause();
  });
  byId('island-prev').addEventListener('click', () => setTrack(currentTrack - 1, true));
  byId('island-next').addEventListener('click', () => setTrack(currentTrack + 1, true));
  audio.addEventListener('play', () => {
    byId('island-play').textContent = 'Ⅱ';
    byId('island-play').setAttribute('aria-label', say('pause'));
    setTriggerCopy();
    setText('island-live-label', say('playing'));
    element.dataset.playing = 'true';
    startSpectrum();
    updateMediaSession();
  });
  audio.addEventListener('pause', () => {
    byId('island-play').textContent = '▶';
    byId('island-play').setAttribute('aria-label', say('play'));
    setTriggerCopy();
    setText('island-live-label', say('ready'));
    element.dataset.playing = 'false';
    cancelAnimationFrame(spectrumFrame);
    bars.forEach((bar, i) => bar.style.setProperty('--level', String([0.32, 0.7, 1, 0.48, 0.78][i % 5])));
    updateMediaSession();
  });
  audio.addEventListener('ended', () =>
    tracks.length > 1 ? setTrack(currentTrack + 1, true) : setText('island-live-label', say('ready')),
  );
  audio.addEventListener('timeupdate', () => {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    byId('island-current-time').textContent = formatTime(audio.currentTime);
    byId('island-duration').textContent = formatTime(duration);
    if (duration) byId('island-seek').value = String(Math.round((audio.currentTime / duration) * 1000));
    updateLyrics();
  });
  byId('island-seek').addEventListener('input', (event) => {
    if (Number.isFinite(audio.duration))
      audio.currentTime = (Number(event.target.value) / 1000) * audio.duration;
  });
  byId('island-volume').addEventListener('input', (event) => {
    audio.volume = Number(event.target.value);
    safeLocalStorage.set('bio.island.volume', String(audio.volume));
  });
  byId('island-lyrics-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (currentTrack < 0) {
      setText('island-lyrics', say('lyricsMissing'));
      return;
    }
    const parsed = parseLrc(await file.text());
    tracks[currentTrack].lyrics = parsed;
    loadedLyrics = parsed;
    setText('island-lyrics-state', parsed.length ? '✓' : '＋');
    setText('island-lyrics', parsed.length ? parsed[0].text : say('noLyrics'));
  });
  const lyricsQuery = byId('island-lyrics-query');
  const lyricsSearch = byId('island-lyrics-search-button');
  lyricsQuery.addEventListener('focus', () => {
    if (!lyricsQuery.value && currentTrack >= 0)
      lyricsQuery.value = tracks[currentTrack].file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
  });
  lyricsSearch.addEventListener('click', async () => {
    if (currentTrack < 0) {
      setText('island-lyrics', say('lyricsMissing'));
      return;
    }
    const query =
      lyricsQuery.value.trim() ||
      tracks[currentTrack].file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ');
    if (!query) return;
    const results = byId('island-lyrics-results');
    results.replaceChildren();
    lyricsSearch.disabled = true;
    setText('island-lyrics', say('lyricsSearching'));
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(12_000),
        mode: 'cors',
      });
      if (!response.ok) throw new Error('LRCLIB request failed');
      const matches = await response.json();
      const usable = Array.isArray(matches)
        ? matches.filter((item) => item.syncedLyrics || item.plainLyrics).slice(0, 5)
        : [];
      if (!usable.length) {
        setText('island-lyrics', say('lyricsSearchEmpty'));
        return;
      }
      for (const item of usable) {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'island-lyrics-result';
        choice.textContent = `${item.trackName || query} — ${item.artistName || (locale() === 'ru' ? 'неизвестный исполнитель' : 'unknown artist')}`;
        choice.addEventListener('click', () => {
          const synced = parseLrc(item.syncedLyrics || '');
          const lyrics = synced.length
            ? synced
            : item.plainLyrics
              ? [{ time: 0, text: item.plainLyrics }]
              : [];
          tracks[currentTrack].lyrics = lyrics;
          loadedLyrics = lyrics;
          setText('island-lyrics-state', lyrics.length ? '✓' : '＋');
          setText('island-lyrics', lyrics.length ? lyrics[0].text : say('noLyrics'));
          if (!synced.length && item.plainLyrics) setText('island-track-artist', say('lyricsPlain'));
          results.replaceChildren();
        });
        results.append(choice);
      }
      setText('island-lyrics', say('lyricsLoaded'));
    } catch {
      setText('island-lyrics', say('lyricsSearchFailed'));
    } finally {
      lyricsSearch.disabled = false;
    }
  });
  function updateLyrics() {
    if (!loadedLyrics.length) return;
    let active = loadedLyrics[0];
    for (const line of loadedLyrics) {
      if (line.time > audio.currentTime) break;
      active = line;
    }
    const node = byId('island-lyrics');
    if (node.textContent !== active.text) node.textContent = active.text;
  }
  function startSpectrum() {
    try {
      if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        audioContext = new AudioContextClass();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        audioContext.createMediaElementSource(audio).connect(analyser);
        analyser.connect(audioContext.destination);
      }
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    } catch {
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    const paint = () => {
      if (audio.paused) return;
      analyser.getByteFrequencyData(data);
      bars.forEach((bar, i) => {
        const value = data[Math.floor((i * data.length) / Math.max(1, bars.length))] / 255;
        bar.style.setProperty('--level', String(Math.max(0.12, value)));
      });
      spectrumFrame = requestAnimationFrame(paint);
    };
    cancelAnimationFrame(spectrumFrame);
    spectrumFrame = requestAnimationFrame(paint);
  }
  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const track = tracks[currentTrack];
    try {
      if (track && 'MediaMetadata' in window)
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.file.name.replace(/\.[^.]+$/, ''),
          artist: 'Aubeig Island',
        });
      navigator.mediaSession.playbackState = !track ? 'none' : audio.paused ? 'paused' : 'playing';
      for (const [action, handler] of Object.entries({
        play: () => audio.play().catch(() => {}),
        pause: () => audio.pause(),
        previoustrack: () => tracks.length && setTrack(currentTrack - 1, true),
        nexttrack: () => tracks.length && setTrack(currentTrack + 1, true),
        seekto: (details) => {
          if (Number.isFinite(details.seekTime)) audio.currentTime = details.seekTime;
        },
      })) {
        try {
          navigator.mediaSession.setActionHandler(action, handler);
        } catch {
          /* action not supported */
        }
      }
      if (audio.duration && Number.isFinite(audio.duration))
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        });
    } catch {
      /* Media Session is an enhancement only. */
    }
  }
  setTriggerCopy();

  function renderShelf() {
    for (const url of shelfThumbnailUrls) URL.revokeObjectURL(url);
    shelfThumbnailUrls.clear();
    const list = byId('island-shelf-list');
    list.replaceChildren();
    byId('island-shelf-count').textContent = String(shelfFiles.length);
    if (!shelfFiles.length) {
      const empty = document.createElement('p');
      empty.className = 'island-shelf-empty';
      empty.textContent = say('noFiles');
      list.append(empty);
      return;
    }
    for (const record of shelfFiles) {
      const row = document.createElement('article');
      row.className = 'island-shelf-item';
      row.draggable = true;
      row.addEventListener('dragstart', (event) => {
        if (record.file) event.dataTransfer.items.add(record.file);
        event.dataTransfer.effectAllowed = 'copy';
      });
      const preview = document.createElement('div');
      preview.className = 'island-file-preview';
      if (record.file?.type.startsWith('image/')) {
        const image = document.createElement('img');
        image.src = URL.createObjectURL(record.file);
        shelfThumbnailUrls.add(image.src);
        image.alt = '';
        image.loading = 'lazy';
        preview.append(image);
      } else
        preview.textContent = record.file?.type.startsWith('audio/')
          ? '♫'
          : record.file?.type.startsWith('video/')
            ? '▶'
            : '▤';
      const info = document.createElement('div');
      info.className = 'island-file-info';
      const name = document.createElement('strong');
      name.textContent = record.name;
      const metadata = document.createElement('small');
      metadata.textContent = `${formatBytes(record.size)} · ${new Date(record.addedAt).toLocaleDateString(locale())}`;
      info.append(name, metadata);
      const actions = document.createElement('div');
      actions.className = 'island-file-actions';
      if (record.file?.type.startsWith('audio/')) {
        const play = document.createElement('button');
        play.type = 'button';
        play.textContent = '▶';
        play.setAttribute('aria-label', locale() === 'ru' ? 'Воспроизвести' : 'Play');
        play.addEventListener('click', () => {
          addAudio([record.file]);
          setTrack(tracks.length - 1, true);
          selectTab('player');
        });
        actions.append(play);
      }
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = '↓';
      download.setAttribute('aria-label', locale() === 'ru' ? 'Скачать файл' : 'Download file');
      download.addEventListener('click', () => {
        if (!record.file) return;
        const url = URL.createObjectURL(record.file);
        const link = document.createElement('a');
        link.href = url;
        link.download = record.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 15_000);
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', locale() === 'ru' ? 'Удалить файл' : 'Remove file');
      remove.addEventListener('click', () => removeShelfFile(record.id));
      actions.append(download, remove);
      row.append(preview, info, actions);
      list.append(row);
    }
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  }
  async function refreshShelf() {
    try {
      shelfFiles = (await shelfTransaction('readonly', (store) => store.getAll())).sort(
        (a, b) => b.addedAt - a.addedAt,
      );
    } catch {
      shelfFiles = [];
      setText('island-shelf-status', say('unsupported'));
    }
    renderShelf();
  }
  async function addShelfFiles(files) {
    const accepted = [...files].filter((file) => file instanceof File);
    if (!accepted.length) return;
    try {
      const database = await openShelfDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction('files', 'readwrite');
        const store = transaction.objectStore('files');
        accepted.forEach((file) =>
          store.put({
            id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
            name: file.name,
            type: file.type,
            size: file.size,
            addedAt: Date.now(),
            file,
          }),
        );
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      setText('island-shelf-status', `${accepted.length} ${say('saved')}`);
      await refreshShelf();
    } catch {
      setText('island-shelf-status', say('saveError'));
    }
  }
  async function removeShelfFile(id) {
    try {
      await shelfTransaction('readwrite', (store) => store.delete(id));
      setText('island-shelf-status', say('deleted'));
      await refreshShelf();
    } catch {
      setText('island-shelf-status', say('saveError'));
    }
  }
  byId('island-shelf-input').addEventListener('change', (event) => {
    addShelfFiles(event.target.files);
    event.target.value = '';
  });
  byId('island-shelf-clear').addEventListener('click', async () => {
    if (!shelfFiles.length || !window.confirm(say('clearConfirm'))) return;
    try {
      await shelfTransaction('readwrite', (store) => store.clear());
      shelfFiles = [];
      renderShelf();
      setText('island-shelf-status', say('deleted'));
    } catch {
      setText('island-shelf-status', say('saveError'));
    }
  });
  const dropzone = byId('island-dropzone');
  for (const type of ['dragenter', 'dragover'])
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  for (const type of ['dragleave', 'drop'])
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
    });
  dropzone.addEventListener('drop', (event) => addShelfFiles(event.dataTransfer.files));
  element.addEventListener('dragover', (event) => {
    if ([...event.dataTransfer.types].includes('Files')) {
      event.preventDefault();
      element.classList.add('is-receiving');
    }
  });
  element.addEventListener('dragleave', (event) => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('is-receiving');
  });
  element.addEventListener('drop', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    element.classList.remove('is-receiving');
    expandingIsland.toggle(true);
    selectTab('shelf');
    addShelfFiles(event.dataTransfer.files);
  });
  refreshShelf();

  function persistTimer() {
    safeLocalStorage.set('bio.island.timer', JSON.stringify(timerState));
  }
  function renderTimer() {
    const remaining = timerState.running
      ? Math.max(0, timerState.endAt - Date.now())
      : Math.max(0, timerState.remainingMs);
    const seconds = Math.ceil(remaining / 1000);
    setText('island-timer-display', formatTime(seconds));
    byId('island-timer-toggle').textContent = timerState.running ? 'Ⅱ' : '▶';
    byId('island-timer-toggle').setAttribute(
      'aria-label',
      timerState.running ? say('timerPaused') : say('timerRunning'),
    );
    setText(
      'island-timer-status',
      timerState.running
        ? say('timerRunning')
        : timerState.remainingMs !== 300_000
          ? say('timerPaused')
          : say('timerReady'),
    );
  }
  function completeTimer() {
    timerState = { endAt: 0, remainingMs: 0, running: false };
    persistTimer();
    clearInterval(timerInterval);
    timerInterval = 0;
    renderTimer();
    setText('island-timer-status', say('timerDone'));
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification('Aubeig Island', { body: say('timerFinishedBody'), tag: 'aubeig-island-timer' });
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = 880;
        gain.gain.value = 0.07;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.45);
        oscillator.stop(context.currentTime + 0.46);
        setTimeout(() => context.close(), 600);
      }
    } catch {
      /* a visual and notification alert remain available */
    }
  }
  function startTimerTicker() {
    clearInterval(timerInterval);
    timerInterval = window.setInterval(() => {
      if (timerState.running && Date.now() >= timerState.endAt) completeTimer();
      else renderTimer();
    }, 250);
  }
  try {
    const savedTimer = JSON.parse(safeLocalStorage.get('bio.island.timer') || 'null');
    if (savedTimer && typeof savedTimer.remainingMs === 'number')
      timerState = { ...timerState, ...savedTimer };
    if (timerState.running && timerState.endAt <= Date.now()) completeTimer();
    else if (timerState.running) startTimerTicker();
  } catch {
    /* use the default five-minute timer */
  }
  const timerRange = byId('island-timer-minutes');
  const setTimerDuration = (minutes) => {
    timerRange.value = String(Math.max(1, Math.min(90, minutes)));
    setText('island-timer-minutes-label', `${timerRange.value} ${say('minutes')}`);
    timerState = { endAt: 0, remainingMs: Number(timerRange.value) * 60_000, running: false };
    persistTimer();
    renderTimer();
  };
  timerRange.addEventListener('input', () => setTimerDuration(Number(timerRange.value)));
  document
    .querySelectorAll('[data-timer-preset]')
    .forEach((button) =>
      button.addEventListener('click', () => setTimerDuration(Number(button.dataset.timerPreset))),
    );
  byId('island-timer-toggle').addEventListener('click', () => {
    if (timerState.running) {
      timerState.remainingMs = Math.max(0, timerState.endAt - Date.now());
      timerState.running = false;
      timerState.endAt = 0;
      clearInterval(timerInterval);
      timerInterval = 0;
    } else {
      if (timerState.remainingMs <= 0) timerState.remainingMs = Number(timerRange.value) * 60_000;
      timerState.running = true;
      timerState.endAt = Date.now() + timerState.remainingMs;
      startTimerTicker();
    }
    persistTimer();
    renderTimer();
  });
  byId('island-timer-reset').addEventListener('click', () => setTimerDuration(Number(timerRange.value)));
  byId('island-notification-permission').addEventListener('click', async () => {
    if (!('Notification' in window)) {
      setText('island-timer-status', say('unsupported'));
      return;
    }
    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    setText(
      'island-timer-status',
      permission === 'granted'
        ? say('permissionGranted')
        : permission === 'denied'
          ? say('permissionDenied')
          : say('permissionDefault'),
    );
  });
  const restoredMinutes = Math.max(
    1,
    Math.min(
      90,
      Math.ceil(
        (timerState.running ? Math.max(0, timerState.endAt - Date.now()) : timerState.remainingMs) / 60_000,
      ),
    ),
  );
  timerRange.value = String(restoredMinutes);
  setText('island-timer-minutes-label', `${restoredMinutes} ${say('minutes')}`);
  renderTimer();
  if (timerState.running) startTimerTicker();

  async function getBarcodeDetector() {
    if (!('BarcodeDetector' in window)) throw new Error('unsupported');
    if (BarcodeDetector.getSupportedFormats) {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes('qr_code')) throw new Error('unsupported');
    }
    if (!barcodeDetector) barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    return barcodeDetector;
  }
  function showQrResult(text) {
    setText('island-qr-result', text ? `${say('qrFound')}: ${text}` : say('qrNoCode'));
    if (text) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'island-qr-copy';
      copy.textContent = locale() === 'ru' ? 'Копировать' : 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = say('copied');
        } catch {
          /* content remains selectable */
        }
      });
      byId('island-qr-result').append(' ', copy);
    }
  }
  byId('island-qr-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const detector = await getBarcodeDetector();
      const bitmap = await createImageBitmap(file);
      const results = await detector.detect(bitmap);
      bitmap.close?.();
      showQrResult(results[0]?.rawValue || '');
    } catch {
      setText('island-qr-result', say('unsupported'));
    }
  });
  byId('island-qr-camera').addEventListener('click', async () => {
    stopCamera();
    try {
      const detector = await getBarcodeDetector();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      const video = byId('island-qr-video');
      video.srcObject = cameraStream;
      video.hidden = false;
      await video.play();
      scanning = true;
      setText('island-qr-result', say('scanning'));
      const scan = async () => {
        if (!scanning) return;
        try {
          if (video.readyState >= 2) {
            const results = await detector.detect(video);
            if (results[0]?.rawValue) {
              showQrResult(results[0].rawValue);
              stopCamera();
              return;
            }
          }
        } catch {
          /* camera frames can be momentarily unavailable */
        }
        cameraFrame = requestAnimationFrame(scan);
      };
      scan();
    } catch (error) {
      stopCamera();
      setText('island-qr-result', error.message === 'unsupported' ? say('unsupported') : say('cameraDenied'));
    }
  });

  byId('island-weather-refresh').addEventListener('click', () => {
    const result = byId('island-weather-result');
    if (!navigator.geolocation) {
      result.textContent = say('noLocation');
      return;
    }
    result.textContent = say('locationLoading');
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        result.textContent = say('weatherLoading');
        try {
          const params = new URLSearchParams({
            latitude: coords.latitude.toFixed(4),
            longitude: coords.longitude.toFixed(4),
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m',
            timezone: 'auto',
          });
          const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
            signal: AbortSignal.timeout(12_000),
            mode: 'cors',
          });
          if (!response.ok) throw new Error('weather unavailable');
          const data = await response.json();
          const current = data.current;
          const units = data.current_units;
          result.replaceChildren();
          const temperature = document.createElement('strong');
          temperature.className = 'island-weather-temp';
          temperature.textContent = `${Math.round(current.temperature_2m)}${units.temperature_2m || '°'}`;
          const location = document.createElement('span');
          location.textContent = `${say('weatherCoord')} · ${coords.latitude.toFixed(2)}, ${coords.longitude.toFixed(2)}`;
          const details = document.createElement('small');
          details.textContent = `${say('feels')} ${Math.round(current.apparent_temperature)}° · ${say('humidity')} ${current.relative_humidity_2m}% · ${say('wind')} ${Math.round(current.wind_speed_10m)} ${units.wind_speed_10m || 'km/h'}`;
          result.append(temperature, location, details);
        } catch {
          result.textContent = say('weatherError');
        }
      },
      (error) => {
        byId('island-weather-result').textContent =
          error.code === 1 ? say('locationDenied') : say('noLocation');
      },
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 60_000 },
    );
  });

  // Vertical pull opens the island, horizontal flicks move through the local playlist.
  trigger.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    gestureConsumed = false;
    clearTimeout(gestureReset);
    dragGesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      active: false,
    };
    try {
      trigger.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is optional */
    }
  });
  trigger.addEventListener('pointermove', (event) => {
    if (!dragGesture || dragGesture.id !== event.pointerId) return;
    const dx = event.clientX - dragGesture.x;
    const dy = event.clientY - dragGesture.y;
    if (!dragGesture.active && Math.max(Math.abs(dx), Math.abs(dy)) > 8) dragGesture.active = true;
    if (!dragGesture.active) return;
    event.preventDefault();
    if (Math.abs(dy) > Math.abs(dx))
      element.style.setProperty('--island-pull', `${Math.max(-8, Math.min(74, dy * 0.72))}px`);
    else element.style.setProperty('--island-pull', `${Math.max(-18, Math.min(18, dx * 0.12))}px`);
  });
  const endGesture = (event) => {
    if (!dragGesture || dragGesture.id !== event.pointerId) return;
    const gesture = dragGesture;
    dragGesture = null;
    element.style.setProperty('--island-pull', '0px');
    if (!gesture.active) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    const elapsed = Math.max(1, performance.now() - gesture.time);
    const speed = Math.hypot(dx, dy) / elapsed;
    if (Math.abs(dx) > 58 && Math.abs(dx) > Math.abs(dy) * 1.25 && tracks.length)
      setTrack(currentTrack + (dx < 0 ? 1 : -1), true);
    else if (dy > 36 || (dy > 16 && speed > 0.55)) expandingIsland.toggle(true);
    else if (dy < -38 && element.dataset.open === 'true') expandingIsland.toggle(false);
    gestureConsumed = true;
    clearTimeout(gestureReset);
    gestureReset = setTimeout(() => {
      gestureConsumed = false;
    }, 450);
  };
  trigger.addEventListener('pointerup', endGesture);
  trigger.addEventListener('pointercancel', endGesture);
  trigger.addEventListener(
    'click',
    (event) => {
      if (!gestureConsumed) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      gestureConsumed = false;
      clearTimeout(gestureReset);
    },
    true,
  );

  const welcome = byId('bio-welcome');
  const welcomeBackground = [...document.body.children].filter(
    (node) => node !== welcome && node.id !== 'app-preloader' && node.tagName !== 'SCRIPT',
  );
  const showWelcome = () => {
    welcome.hidden = false;
    welcomeBackground.forEach((node) => {
      node.inert = true;
    });
    byId('welcome-explore').focus({ preventScroll: true });
  };
  const finishWelcome = (openIsland) => {
    welcome.hidden = true;
    welcomeBackground.forEach((node) => {
      node.inert = false;
    });
    if (byId('welcome-remember').checked) safeLocalStorage.set('bio.island.welcomeSeen', 'yes');
    try {
      sessionStorage.setItem('bio.island.welcomeDismissed', 'yes');
    } catch {
      /* session storage can be disabled */
    }
    if (openIsland) {
      queueMicrotask(() => {
        expandingIsland.toggle(true);
        selectTab('player');
        trigger.focus({ preventScroll: true });
      });
    } else {
      document.querySelector('.rail-link[data-view="home"]')?.focus({ preventScroll: true });
    }
  };
  if (welcome) {
    window.addEventListener(
      'apprevealed',
      () => {
        let dismissedThisSession = false;
        try {
          dismissedThisSession = sessionStorage.getItem('bio.island.welcomeDismissed') === 'yes';
        } catch {
          /* storage can be disabled */
        }
        if (safeLocalStorage.get('bio.island.welcomeSeen') === 'yes' || dismissedThisSession) return;
        showWelcome();
      },
      { once: true },
    );
    byId('welcome-skip').addEventListener('click', () => finishWelcome(false));
    byId('welcome-explore').addEventListener('click', () => finishWelcome(false));
    byId('welcome-island').addEventListener('click', () => finishWelcome(true));
    byId('island-welcome-replay').addEventListener('click', () => {
      expandingIsland.toggle(false);
      showWelcome();
    });
    welcome.addEventListener('click', (event) => {
      if (event.target === welcome) finishWelcome(false);
    });
    welcome.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = [
        ...welcome.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href]'),
      ].filter((node) => node.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !welcome.hidden) finishWelcome(false);
    });
  }
  const languageObserver = new MutationObserver(() => {
    setTriggerCopy();
    setText('island-panel-title', locale() === 'ru' ? 'Твоё пространство рядом' : 'Your space, close by');
    setText('island-track-artist', currentTrack >= 0 ? say('localOnly') : '');
    setText('island-lyrics', loadedLyrics.length ? byId('island-lyrics').textContent : say('noLyrics'));
    setText('island-timer-minutes-label', `${timerRange.value} ${say('minutes')}`);
    renderTimer();
    renderShelf();
  });
  languageObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  window.addEventListener('pagehide', () => {
    stopCamera();
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    for (const url of shelfThumbnailUrls) URL.revokeObjectURL(url);
    shelfThumbnailUrls.clear();
    if (audioContext) audioContext.close().catch(() => {});
  });
}
