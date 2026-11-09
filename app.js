const $ = (id) => document.getElementById(id);
const DB_NAME = 'husnayain-meeting-recorder';
const DB_VERSION = 1;
const MAX_BYTES = 24.5 * 1024 * 1024;           // batas OpenAI 25 MB, sisakan sedikit ruang
const SETTINGS_KEY = 'hm_settings';
const SPEAKER_COLORS = ['#3978e8', '#e0883a', '#2f9e77', '#b25cc9', '#d6535b', '#6b7f95'];

let db;
let recorder = null;
let stream = null;
let chunks = [];
let startedAt = 0;
let elapsedBeforePause = 0;
let timerInterval = null;
let currentStatus = 'idle';
let currentMime = '';
let objectUrls = [];
const busy = new Set();
let openItem = null;

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('recordings')) {
        const store = database.createObjectStore('recordings', { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function dbRequest(mode, action, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', mode);
    const store = tx.objectStore('recordings');
    const req = action === 'getAll' ? store.getAll()
      : action === 'get' ? store.get(value)
      : action === 'delete' ? store.delete(value)
      : store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------- Util ---------- */
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.classList.remove('show'), 3200);
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = s % 60;
  return `${m} m ${String(sec).padStart(2, '0')} d`;
}
function elapsed() { return elapsedBeforePause + (currentStatus === 'recording' ? Date.now() - startedAt : 0); }
function tick() { $('timer').textContent = fmtTime(elapsed()); }
function humanSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function labelType(type) { return type === 'offline' ? 'Rapat offline' : type === 'online' ? 'Rapat online' : 'Lainnya'; }
function dateLabel(iso) { return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- Pengaturan ---------- */
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function openSettings() {
  const s = getSettings();
  $('set-url').value = s.url || '';
  $('set-key').value = s.key || '';
  $('set-result').textContent = '';
  $('settings-modal').hidden = false;
}
function readSettingsForm() {
  return { url: $('set-url').value.trim().replace(/\/+$/, ''), key: $('set-key').value.trim() };
}
async function testConnection() {
  const s = readSettingsForm();
  const out = $('set-result');
  if (!s.url || !s.key) { out.textContent = 'Isi URL dan kode akses dulu.'; return; }
  out.textContent = 'Menguji…';
  try {
    const r = await fetch(`${s.url}?ping=1`, { headers: { 'x-app-key': s.key } });
    if (r.status === 401) out.textContent = '✗ Kode akses salah.';
    else if (r.ok) out.textContent = '✓ Terhubung ke server.';
    else out.textContent = `✗ Server menjawab kode ${r.status}. Periksa URL dan deploy fungsi.`;
  } catch {
    out.textContent = '✗ Tidak dapat terhubung. Periksa URL dan koneksi internet.';
  }
}
function saveSettings() {
  const s = readSettingsForm();
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  $('settings-modal').hidden = true;
  toast('Pengaturan disimpan.');
}

/* ---------- Perekaman ---------- */
function setStatus(status, message) {
  currentStatus = status;
  $('record-state-text').textContent = message;
  $('record-indicator').className = 'record-indicator' + (status === 'recording' ? ' live' : status === 'paused' ? ' paused' : '');
  document.querySelector('.wave').classList.toggle('active', status === 'recording');
  $('orb-status').textContent = status === 'recording' ? 'SEDANG MEREKAM' : status === 'paused' ? 'REKAMAN PAUSE' : status === 'saving' ? 'MENYIMPAN' : 'SIAP MEREKAM';
  $('start-btn').disabled = status === 'recording' || status === 'paused' || status === 'saving';
  $('pause-btn').disabled = status !== 'recording' && status !== 'paused';
  $('pause-btn').textContent = status === 'paused' ? '▶ Lanjutkan' : 'Ⅱ Pause';
  $('stop-btn').disabled = status !== 'recording' && status !== 'paused';
}
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('Browser ini belum mendukung perekaman. Coba Chrome terbaru.'); return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    // 32 kbps mono cukup untuk suara dan menjaga file tetap < 25 MB hingga ± 100 menit
    const options = { audioBitsPerSecond: 32000 };
    const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    currentMime = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    if (currentMime) options.mimeType = currentMime;
    recorder = new MediaRecorder(stream, options);
    chunks = [];
    elapsedBeforePause = 0;
    startedAt = Date.now();
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = () => toast('Terjadi kendala pada perekaman.');
    recorder.onstop = saveRecording;
    recorder.start(1000);
    setStatus('recording', 'Rekaman berjalan. Mikrofon aktif.');
    tick(); timerInterval = setInterval(tick, 250);
    toast('Perekaman dimulai.');
  } catch (error) {
    const msg = error.name === 'NotAllowedError' ? 'Akses mikrofon ditolak. Izinkan mikrofon pada browser.' :
      error.name === 'NotFoundError' ? 'Mikrofon tidak ditemukan.' : 'Mikrofon tidak dapat diakses. Pastikan menggunakan HTTPS.';
    toast(msg);
  }
}
function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause(); elapsedBeforePause += Date.now() - startedAt;
    setStatus('paused', 'Rekaman dijeda. Tekan Lanjutkan untuk kembali merekam.'); tick();
  } else if (recorder.state === 'paused') {
    recorder.resume(); startedAt = Date.now();
    setStatus('recording', 'Rekaman berjalan. Mikrofon aktif.');
  }
}
function stopRecording() {
  if (!recorder || (recorder.state !== 'recording' && recorder.state !== 'paused')) return;
  if (recorder.state === 'recording') elapsedBeforePause += Date.now() - startedAt;
  clearInterval(timerInterval); tick();
  setStatus('saving', 'Rekaman dihentikan. Menyimpan audio ke perangkat…');
  recorder.stop();
  if (stream) stream.getTracks().forEach(track => track.stop());
}
async function saveRecording() {
  try {
    const blob = new Blob(chunks, { type: currentMime || chunks[0]?.type || 'audio/webm' });
    if (!blob.size) throw new Error('Rekaman kosong');
    const title = $('meeting-title').value.trim() || 'Rapat tanpa judul';
    const type = $('meeting-type').value;
    const item = {
      id: crypto.randomUUID(), title, type, createdAt: new Date().toISOString(),
      durationMs: elapsedBeforePause, size: blob.size, mimeType: blob.type, blob,
      tStatus: 'none'
    };
    await dbRequest('readwrite', 'put', item);
    await renderRecordings();
    $('meeting-title').value = 'Rapat Baru';
    $('timer').textContent = '00:00:00';
    setStatus('idle', 'Rekaman tersimpan di perangkat ini.');
    toast('Audio berhasil disimpan secara lokal.');
  } catch (e) {
    setStatus('idle', 'Gagal menyimpan rekaman. Periksa ruang penyimpanan.');
    toast('Gagal menyimpan audio.');
  } finally {
    recorder = null; chunks = []; stream = null;
  }
}

/* ---------- Transkripsi ---------- */
function setCardStatus(id, text, opts = {}) {
  const card = document.querySelector(`[data-id="${id}"]`);
  if (!card) return;
  const st = card.querySelector('.t-status');
  const bar = card.querySelector('.t-bar');
  if (st) { st.textContent = text; st.className = 't-status' + (opts.err ? ' err' : opts.ok ? ' ok' : ''); }
  if (bar) {
    bar.hidden = opts.pct === undefined && !opts.indeterminate;
    bar.classList.toggle('indeterminate', !!opts.indeterminate);
    if (opts.pct !== undefined) bar.firstElementChild.style.width = `${opts.pct}%`;
  }
}
function uploadAudio(item, s, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    const ext = (item.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
    fd.append('file', item.blob, `rapat.${ext}`);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', s.url);
    xhr.setRequestHeader('x-app-key', s.key);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* abaikan */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.id) resolve(data.id);
      else reject(new Error(data.error || `Server menolak unggahan (kode ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Gagal terhubung ke server. Periksa internet dan URL pengaturan.'));
    xhr.send(fd);
  });
}
async function pollJob(item, jobId, s) {
  const started = Date.now();
  for (;;) {
    await sleep(4000);
    if (Date.now() - started > 15 * 60 * 1000) throw new Error('Waktu tunggu habis. Coba transkripsi ulang.');
    let r;
    try { r = await fetch(`${s.url}?id=${jobId}`, { headers: { 'x-app-key': s.key } }); }
    catch { setCardStatus(item.id, 'Koneksi terputus, mencoba lagi…', { indeterminate: true }); continue; }
    if (r.status === 401) throw new Error('Kode akses salah. Periksa Pengaturan AI.');
    if (r.status === 404) throw new Error('Pekerjaan tidak ditemukan di server. Coba transkripsi ulang.');
    if (!r.ok) continue;
    const d = await r.json();
    if (d.status === 'done') {
      item.transcript = d.result;
      item.tStatus = 'done';
      item.tError = '';
      await dbRequest('readwrite', 'put', item);
      fetch(`${s.url}?id=${jobId}`, { method: 'DELETE', headers: { 'x-app-key': s.key } }).catch(() => {});
      return;
    }
    if (d.status === 'error') throw new Error(d.error || 'Transkripsi gagal di server.');
    setCardStatus(item.id, 'AI sedang menyusun transkrip dan memisahkan pembicara…', { indeterminate: true });
  }
}
async function transcribe(id, resumeJobId) {
  if (busy.has(id)) return;
  const s = getSettings();
  if (!s.url || !s.key) { toast('Isi Pengaturan AI dulu.'); openSettings(); return; }
  if (!navigator.onLine) { toast('Sedang offline. Rekaman aman—coba lagi saat internet tersedia.'); return; }
  const item = await dbRequest('readonly', 'get', id);
  if (!item) return;
  if (!resumeJobId && item.size > MAX_BYTES) {
    toast(`File ${humanSize(item.size)} melebihi batas 25 MB. Rekaman baru otomatis lebih kecil.`); return;
  }
  busy.add(id);
  try {
    let jobId = resumeJobId;
    if (!jobId) {
      item.tStatus = 'uploading'; item.tError = '';
      await dbRequest('readwrite', 'put', item);
      await renderRecordings();
      setCardStatus(id, 'Mengunggah audio… 0%', { pct: 0 });
      jobId = await uploadAudio(item, s, pct => setCardStatus(id, `Mengunggah audio… ${pct}%`, { pct }));
      item.jobId = jobId; item.tStatus = 'processing';
      await dbRequest('readwrite', 'put', item);
    }
    setCardStatus(id, 'AI sedang menyusun transkrip dan memisahkan pembicara…', { indeterminate: true });
    await pollJob(item, jobId, s);
    toast('Transkrip selesai.');
  } catch (e) {
    item.tStatus = 'error'; item.tError = e.message;
    await dbRequest('readwrite', 'put', item);
  } finally {
    busy.delete(id);
    await renderRecordings();
  }
}

/* ---------- Transkrip: tampilan, nama pembicara, ekspor ---------- */
function speakerOrder(item) {
  const order = [];
  (item.transcript?.segments || []).forEach(seg => { if (!order.includes(seg.speaker)) order.push(seg.speaker); });
  return order;
}
function speakerName(item, raw) {
  const custom = item.speakerNames?.[raw]?.trim();
  if (custom) return custom;
  return `Pembicara ${speakerOrder(item).indexOf(raw) + 1}`;
}
function mergedSegments(item) {
  const out = [];
  (item.transcript?.segments || []).forEach(seg => {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end < 2) { last.text += ' ' + seg.text; last.end = seg.end; }
    else out.push({ ...seg });
  });
  return out;
}
function renderTranscriptBody() {
  const item = openItem; const body = $('tr-body'); body.innerHTML = '';
  const order = speakerOrder(item);
  mergedSegments(item).forEach(seg => {
    const row = document.createElement('div'); row.className = 'tr-seg';
    const meta = document.createElement('div'); meta.className = 'tr-meta';
    const name = document.createElement('b'); name.textContent = speakerName(item, seg.speaker);
    name.style.color = SPEAKER_COLORS[order.indexOf(seg.speaker) % SPEAKER_COLORS.length];
    const time = document.createElement('span'); time.textContent = fmtTime(seg.start * 1000);
    meta.append(name, time);
    const p = document.createElement('p'); p.textContent = seg.text;
    row.append(meta, p); body.append(row);
  });
  if (!body.children.length) body.textContent = 'Transkrip kosong. Pastikan suara terekam jelas.';
}
function openTranscript(item) {
  openItem = item;
  $('tr-title').textContent = item.title;
  const box = $('tr-speakers'); box.innerHTML = '';
  speakerOrder(item).forEach((raw, i) => {
    const label = document.createElement('label');
    const dot = document.createElement('span'); dot.className = 'sp-dot'; dot.style.background = SPEAKER_COLORS[i % SPEAKER_COLORS.length];
    const input = document.createElement('input');
    input.placeholder = `Pembicara ${i + 1}`; input.value = item.speakerNames?.[raw] || ''; input.maxLength = 40;
    input.addEventListener('input', () => {
      item.speakerNames = item.speakerNames || {}; item.speakerNames[raw] = input.value; renderTranscriptBody();
    });
    input.addEventListener('change', () => { dbRequest('readwrite', 'put', item).catch(() => toast('Nama pembicara gagal disimpan.')); });
    label.append(dot, input); box.append(label);
  });
  renderTranscriptBody();
  $('transcript-modal').hidden = false;
}
function transcriptText(item) {
  const head = `${item.title}\n${dateLabel(item.createdAt)} · ${labelType(item.type)}\n\n`;
  return head + mergedSegments(item).map(seg => `[${fmtTime(seg.start * 1000)}] ${speakerName(item, seg.speaker)}: ${seg.text}`).join('\n\n') + '\n';
}
async function copyTranscript() {
  try { await navigator.clipboard.writeText(transcriptText(openItem)); toast('Transkrip disalin.'); }
  catch { toast('Tidak dapat menyalin. Gunakan Unduh TXT.'); }
}
function downloadTranscript() {
  const blob = new Blob([transcriptText(openItem)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const safe = openItem.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'transkrip-rapat';
  const a = document.createElement('a'); a.href = url; a.download = `Transkrip-${safe}-${openItem.createdAt.slice(0, 10)}.txt`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------- Daftar rekaman ---------- */
function buildTranscribeRow(item) {
  const row = document.createElement('div'); row.className = 't-row';
  const status = document.createElement('div'); status.className = 't-status';
  const bar = document.createElement('div'); bar.className = 't-bar'; bar.hidden = true; bar.append(document.createElement('i'));
  const btn = (text, cls, fn) => { const b = document.createElement('button'); b.className = 'small-btn ' + cls; b.textContent = text; b.onclick = fn; return b; };
  const st = item.tStatus || 'none';
  if (st === 'uploading' || st === 'processing') {
    status.textContent = st === 'uploading' ? 'Mengunggah audio…' : 'AI sedang menyusun transkrip…';
    row.append(status, bar);
    if (st === 'processing' && !busy.has(item.id)) row.append(btn('Cek hasil', '', () => transcribe(item.id, item.jobId)));
  } else if (st === 'done') {
    status.textContent = `✓ Transkrip siap · ${speakerOrder(item).length} pembicara terdeteksi`; status.className = 't-status ok';
    row.append(status, bar, btn('Lihat transkrip', 'primary', () => openTranscript(item)), btn('Ulangi', '', () => { if (confirm('Transkripsi ulang akan mengganti transkrip dan nama pembicara yang sudah diedit. Lanjutkan?')) transcribe(item.id); }));
  } else if (st === 'error') {
    status.textContent = `✗ ${item.tError || 'Transkripsi gagal.'}`; status.className = 't-status err';
    row.append(status, bar, btn('Coba lagi', 'primary', () => transcribe(item.id)));
  } else {
    status.textContent = 'Belum ditranskripsi.';
    row.append(status, bar, btn('✨ Transkripsi', 'primary', () => transcribe(item.id)));
  }
  return row;
}
async function renderRecordings() {
  const list = $('recordings-list');
  objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = [];
  const records = (await dbRequest('readonly', 'getAll')).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  $('recording-count').textContent = `${records.length} rekaman`;
  if (!records.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">♫</div><strong>Belum ada rekaman</strong><p>Rekaman rapat yang selesai akan muncul di sini.</p></div>'; return;
  }
  list.innerHTML = '';
  records.forEach(item => {
    const card = document.createElement('article'); card.className = 'recording-card'; card.dataset.id = item.id;
    const info = document.createElement('div'); info.className = 'recording-info';
    const title = document.createElement('strong'); title.textContent = item.title;
    const meta = document.createElement('div'); meta.className = 'recording-meta';
    const tag = document.createElement('span'); tag.className = 'type-tag'; tag.textContent = labelType(item.type);
    const date = document.createElement('span'); date.textContent = dateLabel(item.createdAt);
    const duration = document.createElement('span'); duration.textContent = fmtDuration(item.durationMs);
    const size = document.createElement('span'); size.textContent = humanSize(item.size);
    meta.append(tag, date, duration, size); info.append(title, meta);
    const audio = document.createElement('audio'); audio.controls = true; audio.className = 'audio-player';
    const url = URL.createObjectURL(item.blob); objectUrls.push(url); audio.src = url; audio.preload = 'metadata'; info.append(audio);
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const download = document.createElement('button'); download.className = 'small-btn'; download.textContent = '↓ Unduh';
    download.onclick = () => downloadItem(item);
    const del = document.createElement('button'); del.className = 'small-btn delete'; del.textContent = 'Hapus';
    del.onclick = async () => {
      if (confirm(`Hapus rekaman "${item.title}" beserta transkripnya dari perangkat ini?`)) {
        await dbRequest('readwrite', 'delete', item.id); await renderRecordings(); toast('Rekaman dihapus.');
      }
    };
    actions.append(download, del);
    card.append(info, actions, buildTranscribeRow(item)); list.append(card);
  });
}
function downloadItem(item) {
  const url = URL.createObjectURL(item.blob);
  const ext = item.mimeType.includes('mp4') ? 'm4a' : 'webm';
  const safe = item.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'rekaman-rapat';
  const a = document.createElement('a'); a.href = url; a.download = `${safe}-${new Date(item.createdAt).toISOString().slice(0, 10)}.${ext}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------- Event & start ---------- */
$('start-btn').addEventListener('click', startRecording);
$('pause-btn').addEventListener('click', togglePause);
$('stop-btn').addEventListener('click', stopRecording);
$('settings-btn').addEventListener('click', openSettings);
$('nav-settings').addEventListener('click', e => { e.preventDefault(); openSettings(); });
$('settings-close').addEventListener('click', () => { $('settings-modal').hidden = true; });
$('set-save').addEventListener('click', saveSettings);
$('set-test').addEventListener('click', testConnection);
$('tr-close').addEventListener('click', () => { $('transcript-modal').hidden = true; openItem = null; renderRecordings(); });
$('tr-copy').addEventListener('click', copyTranscript);
$('tr-download').addEventListener('click', downloadTranscript);
['settings-modal', 'transcript-modal'].forEach(id => $(id).addEventListener('click', e => {
  if (e.target === $(id)) { $(id).hidden = true; if (id === 'transcript-modal') { openItem = null; renderRecordings(); } }
}));
window.addEventListener('online', () => toast('Kembali online. Kamu bisa menjalankan transkripsi.'));

(async () => {
  try {
    db = await openDB();
    // pulihkan status: unggahan yang terputus → error; job yang sedang diproses → lanjut polling
    const all = await dbRequest('readonly', 'getAll');
    const resume = [];
    for (const it of all) {
      if (it.tStatus === 'uploading') {
        it.tStatus = 'error'; it.tError = 'Unggahan terputus. Tekan Coba lagi.';
        await dbRequest('readwrite', 'put', it);
      } else if (it.tStatus === 'processing' && it.jobId) resume.push(it);
    }
    await renderRecordings();
    if (navigator.onLine) resume.forEach(it => transcribe(it.id, it.jobId));
  } catch (e) { toast('Penyimpanan browser tidak dapat diinisialisasi.'); }
  setStatus('idle', 'Siap. Izinkan akses mikrofon untuk mulai.');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
