const $ = (id) => document.getElementById(id);
const DB_NAME = 'husnayain-meeting-recorder';
const DB_VERSION = 1;
let db;
let recorder = null;
let stream = null;
let chunks = [];
let startedAt = 0;
let elapsedBeforePause = 0;
let timerInterval = null;
let currentStatus = 'idle';
let currentMime = '';

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
    const req = action === 'getAll' ? store.getAll() : action === 'delete' ? store.delete(value) : store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function toast(message) {
  const el = $('toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timeout); toast.timeout = setTimeout(() => el.classList.remove('show'), 2800);
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h,m,sec].map(n => String(n).padStart(2,'0')).join(':');
}
function fmtDuration(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), sec=s%60;
  return `${m} m ${String(sec).padStart(2,'0')} d`;
}
function elapsed() {
  return elapsedBeforePause + (currentStatus === 'recording' ? Date.now() - startedAt : 0);
}
function tick() { $('timer').textContent = fmtTime(elapsed()); }
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
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const options = {};
    const mimeCandidates = ['audio/webm;codecs=opus','audio/webm','audio/mp4'];
    currentMime = mimeCandidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    if (currentMime) options.mimeType = currentMime;
    recorder = new MediaRecorder(stream, options);
    chunks = [];
    elapsedBeforePause = 0;
    startedAt = Date.now();
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onerror = e => toast('Terjadi kendala pada perekaman.');
    recorder.onstop = saveRecording;
    recorder.start(1000);
    setStatus('recording','Rekaman berjalan. Mikrofon aktif.');
    tick(); timerInterval = setInterval(tick, 250);
    toast('Perekaman dimulai.');
  } catch (error) {
    let msg = error.name === 'NotAllowedError' ? 'Akses mikrofon ditolak. Izinkan mikrofon pada browser.' :
      error.name === 'NotFoundError' ? 'Mikrofon tidak ditemukan.' : 'Mikrofon tidak dapat diakses. Pastikan menggunakan HTTPS.';
    toast(msg);
  }
}
function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause(); elapsedBeforePause += Date.now() - startedAt;
    setStatus('paused','Rekaman dijeda. Tekan Lanjutkan untuk kembali merekam.'); tick();
  } else if (recorder.state === 'paused') {
    recorder.resume(); startedAt = Date.now();
    setStatus('recording','Rekaman berjalan. Mikrofon aktif.');
  }
}
function stopRecording() {
  if (!recorder || (recorder.state !== 'recording' && recorder.state !== 'paused')) return;
  if (recorder.state === 'recording') elapsedBeforePause += Date.now() - startedAt;
  clearInterval(timerInterval); tick();
  setStatus('saving','Rekaman dihentikan. Menyimpan audio ke perangkat…');
  recorder.stop();
  if (stream) stream.getTracks().forEach(track => track.stop());
}
async function saveRecording() {
  try {
    const blob = new Blob(chunks, { type: currentMime || chunks[0]?.type || 'audio/webm' });
    if (!blob.size) throw new Error('Rekaman kosong');
    const title = $('meeting-title').value.trim() || 'Rapat tanpa judul';
    const type = $('meeting-type').value;
    const item = { id: crypto.randomUUID(), title, type, createdAt: new Date().toISOString(),
      durationMs: elapsedBeforePause, size: blob.size, mimeType: blob.type, blob };
    await dbRequest('readwrite','put',item);
    await renderRecordings();
    $('meeting-title').value = 'Rapat Baru';
    $('timer').textContent = '00:00:00';
    setStatus('idle','Rekaman tersimpan di perangkat ini.');
    toast('Audio berhasil disimpan secara lokal.');
  } catch (e) {
    setStatus('idle','Gagal menyimpan rekaman. Periksa ruang penyimpanan.');
    toast('Gagal menyimpan audio.');
  } finally {
    recorder = null; chunks = []; stream = null;
  }
}
function humanSize(bytes) {
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}
function labelType(type) { return type === 'offline' ? 'Rapat offline' : type === 'online' ? 'Rapat online' : 'Lainnya'; }
function dateLabel(iso) { return new Date(iso).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'}); }
async function renderRecordings() {
  const list = $('recordings-list');
  const records = (await dbRequest('readonly','getAll')).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  $('recording-count').textContent = `${records.length} rekaman`;
  if (!records.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">♫</div><strong>Belum ada rekaman</strong><p>Rekaman rapat yang selesai akan muncul di sini.</p></div>'; return;
  }
  list.innerHTML = '';
  records.forEach(item => {
    const card = document.createElement('article'); card.className = 'recording-card';
    const info = document.createElement('div'); info.className = 'recording-info';
    const title = document.createElement('strong'); title.textContent = item.title;
    const meta = document.createElement('div'); meta.className = 'recording-meta';
    const tag = document.createElement('span'); tag.className = 'type-tag'; tag.textContent = labelType(item.type);
    const date = document.createElement('span'); date.textContent = dateLabel(item.createdAt);
    const duration = document.createElement('span'); duration.textContent = fmtDuration(item.durationMs);
    const size = document.createElement('span'); size.textContent = humanSize(item.size);
    meta.append(tag,date,duration,size); info.append(title,meta);
    const audio = document.createElement('audio'); audio.controls = true; audio.className = 'audio-player'; audio.src = URL.createObjectURL(item.blob); audio.preload = 'metadata'; info.append(audio);
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const download = document.createElement('button'); download.className = 'small-btn'; download.textContent = '↓ Unduh';
    download.onclick = () => downloadItem(item);
    const del = document.createElement('button'); del.className = 'small-btn delete'; del.textContent = 'Hapus';
    del.onclick = async () => { if (confirm(`Hapus rekaman "${item.title}" dari perangkat ini?`)) { await dbRequest('readwrite','delete',item.id); await renderRecordings(); toast('Rekaman dihapus.'); } };
    actions.append(download,del); card.append(info,actions); list.append(card);
  });
}
function downloadItem(item) {
  const url = URL.createObjectURL(item.blob);
  const ext = item.mimeType.includes('mp4') ? 'm4a' : 'webm';
  const safe = item.title.replace(/[\\/:*?"<>|]+/g,'-').slice(0,80) || 'rekaman-rapat';
  const a = document.createElement('a'); a.href = url; a.download = `${safe}-${new Date(item.createdAt).toISOString().slice(0,10)}.${ext}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1500);
}
$('start-btn').addEventListener('click',startRecording);
$('pause-btn').addEventListener('click',togglePause);
$('stop-btn').addEventListener('click',stopRecording);
(async()=>{
  try { db = await openDB(); await renderRecordings(); }
  catch(e) { toast('Penyimpanan browser tidak dapat diinisialisasi.'); }
  setStatus('idle','Siap. Izinkan akses mikrofon untuk mulai.');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
})();
