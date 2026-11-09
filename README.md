# Husnayain Meeting Notes — PWA Tahap 1

PWA perekam rapat dengan penyimpanan audio lokal di browser (IndexedDB).

## Fitur
- Rekam mikrofon untuk rapat offline / online (audio yang masuk ke mikrofon perangkat).
- Mulai, pause, lanjutkan, dan stop.
- Simpan rekaman lokal, putar ulang, unduh file audio, hapus rekaman.
- Riwayat rapat, jenis rapat, waktu, durasi, ukuran file.
- PWA installable dan app shell offline cache.

## Cara menjalankan
**Disarankan:** deploy ke GitHub Pages (HTTPS), atau jalankan server lokal. Browser umumnya mensyaratkan HTTPS/localhost untuk akses mikrofon.

### GitHub Pages
1. Ekstrak ZIP.
2. Unggah seluruh isi folder ke root repo GitHub.
3. Repo Settings → Pages → pilih branch `main`, folder `/root` → Save.
4. Buka URL Pages menggunakan Chrome Android/PC.
5. Izinkan akses mikrofon.
6. Di Chrome Android: menu ⋮ → `Install app` atau `Tambahkan ke layar utama`.

### Pengujian lokal di PC
Dengan Python terpasang, dari folder proyek:
```bash
python -m http.server 8000
```
Buka `http://localhost:8000`.

## Batasan tahap 1
- Tahap ini merekam dari mikrofon saja. PWA tidak otomatis menangkap audio internal Zoom/Meet di Android.
- Pada PC, capture audio tab/sistem memerlukan flow browser khusus (mis. screen/tab sharing dengan audio) yang belum termasuk di tahap 1.
- Transkripsi, pemisahan pembicara, dan ringkasan AI belum diintegrasikan (rencana tahap 2).
- Rekaman disimpan di browser/perangkat yang digunakan. Data tidak tersinkron otomatis dan bisa hilang jika data situs/browser dihapus.
- Tetap buka aplikasi selama merekam; browser/mobile OS dapat menghentikan perekaman di latar belakang/layar terkunci.
- Font Google hanya digunakan bila online; layout tetap berfungsi offline.
- Sebelum merekam rapat, pastikan peserta mengetahui dan menyetujui perekaman.

## Teknologi
HTML, CSS, JavaScript, MediaRecorder API, IndexedDB, Service Worker, Web App Manifest.
