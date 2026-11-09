# Husnayain Meeting Notes — PWA Tahap 2
Transkripsi suara Bahasa Indonesia + pemisahan pembicara (OpenAI `gpt-4o-transcribe-diarize`) lewat Supabase Edge Function.

## Alur
HP/PC → (audio, kode akses) → Supabase Edge Function → OpenAI → hasil disimpan sementara di tabel `meeting_jobs` → aplikasi mengambil hasil, menyimpannya di perangkat, lalu menghapus job dari server.
API key OpenAI hanya ada di Supabase, tidak pernah di aplikasi/GitHub.

## Pasang (sekali saja)
### 1. Database
Supabase → SQL Editor → tempel isi `supabase/setup.sql` → Run.

### 2. Edge Function
**Lewat Supabase CLI**
```bash
supabase functions deploy transcribe --no-verify-jwt
supabase secrets set OPENAI_API_KEY=sk-xxxx APP_PASSCODE=kode-rahasia-pilihanmu
```
**Lewat Dashboard**: Edge Functions → Deploy a new function → nama `transcribe` → tempel isi `supabase/functions/transcribe/index.ts` → matikan *Verify JWT* → Deploy. Lalu Edge Functions → Secrets → tambah `OPENAI_API_KEY` dan `APP_PASSCODE`.

Opsional: `OPENAI_TIMEOUT_SEC` (bawaan 140, cocok untuk paket Free yang batas waktunya 150 detik; paket berbayar bisa dinaikkan hingga ± 380).

### 3. Aplikasi
Ganti semua file di repo GitHub dengan isi folder ini (index.html, app.js, style.css, sw.js, manifest.json, icon.svg). Folder `supabase/` tidak perlu diunggah ke GitHub Pages.

### 4. Hubungkan
Buka aplikasi → **Pengaturan AI** → isi URL `https://<project-ref>.supabase.co/functions/v1/transcribe` dan kode akses → **Tes koneksi** → Simpan.

## Batasan
- Batas file OpenAI 25 MB. Rekaman baru memakai 32 kbps mono (± 14 MB/jam), jadi aman hingga sekitar 100 menit. Rekaman Tahap 1 yang lebih besar akan ditolak dengan pesan jelas.
- Label pembicara dibuat per rekaman; nama (mis. Kepala Madrasah) diisi manual di jendela transkrip.
- Mikrofon tunggal: pembicara yang jauh atau berbicara bersamaan bisa salah dikenali.
- Transkripsi butuh internet; merekam tetap offline.
- Biaya mengikuti tarif OpenAI untuk model transkripsi—cek halaman harga OpenAI.
