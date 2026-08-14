// ===== Deteksi Plat Nomor - app.js =====

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const previewImg = document.getElementById('preview-img');
const loadingEl = document.getElementById('loading');
const loadingDetail = document.getElementById('loading-detail');
const statusPill = document.getElementById('status-pill');
const permError = document.getElementById('permission-error');
const btnScan = document.getElementById('btn-scan');
const btnUpload = document.getElementById('btn-upload');
const btnRetry = document.getElementById('btn-retry');
const fileInput = document.getElementById('file-input');
const captureCanvas = document.getElementById('capture-canvas');
const captureCtx = captureCanvas.getContext('2d');
const resultPanel = document.getElementById('result-panel');
const resultPlate = document.getElementById('result-plate');
const resultConf = document.getElementById('result-conf');
const resultRaw = document.getElementById('result-raw');
const matchBadge = document.getElementById('match-badge');
const matchInfo = document.getElementById('match-info');
const processedPreview = document.getElementById('processed-preview');

// Tab & halaman data
const tabScan = document.getElementById('tab-scan');
const tabData = document.getElementById('tab-data');
const dataView = document.getElementById('data-view');
const inputPlat = document.getElementById('input-plat');
const inputNama = document.getElementById('input-nama');
const inputNim = document.getElementById('input-nim');
const btnTambahData = document.getElementById('btn-tambah-data');
const dataListEl = document.getElementById('data-list');

const DB_KEY = 'plat_db_v1';

let currentStream = null;
let cameraAvailable = true;
let isBusy = false;
let usingUploadedImage = false;
let ocrWorker = null;

function setStatus(text, cls) {
  statusPill.textContent = text;
  statusPill.className = '';
  if (cls) statusPill.classList.add(cls);
}

// ---- 1. Setup kamera (opsional, tetap bisa pakai upload kalau gagal) ----
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    currentStream = stream;
    video.srcObject = stream;
    cameraAvailable = true;
    permError.classList.remove('show');
    return new Promise((resolve) => {
      video.onloadedmetadata = () => { video.play(); resolve(); };
    });
  } catch (err) {
    console.warn('Kamera tidak tersedia, tetap bisa pakai upload:', err);
    cameraAvailable = false;
    permError.classList.add('show');
  }
}

// ---- 2. Siapkan mesin OCR ----
async function loadOcrEngine() {
  loadingDetail.textContent = 'Memuat mesin OCR (bisa 10-30 detik)...';
  ocrWorker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') {
        loadingDetail.textContent = `Membaca teks... ${Math.round(m.progress * 100)}%`;
      }
    },
  });
  // Batasi karakter yang dicari cuma huruf & angka (sesuai format plat)
  await ocrWorker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  });
}

// ---- 3. Bersihkan & format hasil OCR jadi mirip format plat ----
function cleanPlateText(rawText) {
  // Buang semua kecuali huruf & angka, kapital semua
  let cleaned = rawText.toUpperCase().replace(/[^A-Z0-9]/g, ' ').trim();
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned;
}

// ---- Preprocessing gambar sebelum di-OCR ----
// Plat nomor Indonesia = teks PUTIH di atas background HITAM.
// OCR pada dasarnya "berpikir" normalnya teks hitam di atas putih,
// jadi kita: (1) perbesar gambar biar detail teks lebih jelas,
// (2) ubah ke hitam-putih tegas (threshold), (3) balik warnanya
// (invert) supaya jadi teks hitam di atas putih.
function preprocessForOcr(sourceCanvas) {
  const targetWidth = 700; // perbesar biar detail teks lebih jelas dibaca OCR
  const scale = Math.max(1, targetWidth / sourceCanvas.width);
  const outW = Math.round(sourceCanvas.width * scale);
  const outH = Math.round(sourceCanvas.height * scale);

  const processed = document.createElement('canvas');
  processed.width = outW;
  processed.height = outH;
  const pctx = processed.getContext('2d');
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(sourceCanvas, 0, 0, outW, outH);

  const imgData = pctx.getImageData(0, 0, outW, outH);
  const d = imgData.data;

  // Hitung rata-rata kecerahan dulu, buat nentuin threshold otomatis
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += gray;
  }
  const avgBrightness = sum / (d.length / 4);
  const threshold = avgBrightness; // pakai rata-rata sebagai batas hitam/putih

  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    // Karena plat = teks putih di background hitam, kita BALIK:
    // area terang (teks asli) -> jadi HITAM (dianggap "teks" oleh OCR)
    // area gelap (background asli) -> jadi PUTIH
    const value = gray > threshold ? 0 : 255;
    d[i] = value;
    d[i + 1] = value;
    d[i + 2] = value;
  }
  pctx.putImageData(imgData, 0, 0);
  return processed;
}

// ---- 4. Jalankan OCR dari sebuah canvas/gambar ----
async function runOcr(sourceCanvas) {
  isBusy = true;
  setStatus('Membaca...', 'busy');
  btnScan.classList.add('busy');
  btnScan.textContent = '⏳ Memproses...';

  try {
    const processedCanvas = preprocessForOcr(sourceCanvas);
    processedPreview.src = processedCanvas.toDataURL();
    const { data } = await ocrWorker.recognize(processedCanvas);
    const cleaned = cleanPlateText(data.text);
    const confidence = Math.round(data.confidence);

    resultPlate.textContent = cleaned || '(tidak terbaca)';
    resultConf.textContent = `Keyakinan OCR: ${confidence}%`;
    resultRaw.textContent = `Teks mentah: "${data.text.trim()}"`;

    // Cocokkan ke database lokal
    const matched = matchPlateToDb(cleaned);
    if (matched) {
      matchBadge.textContent = '✓ Terdaftar';
      matchBadge.className = 'terdaftar';
      matchInfo.innerHTML = `<strong>${matched.nama}</strong><br>NIM/NIP: ${matched.nim || '-'}`;
    } else {
      matchBadge.textContent = '✕ Tidak Terdaftar';
      matchBadge.className = 'tidak';
      matchInfo.textContent = 'Plat ini belum ada di database.';
    }

    resultPanel.classList.add('show');

    setStatus('Selesai', 'ready');
    btnRetry.classList.add('show');
  } catch (err) {
    console.error('OCR gagal:', err);
    setStatus('Gagal baca', 'error');
    resultPlate.textContent = 'Gagal membaca';
    resultConf.textContent = 'Coba foto ulang dengan pencahayaan lebih baik';
    resultPanel.classList.add('show');
  } finally {
    isBusy = false;
    btnScan.classList.remove('busy');
    btnScan.textContent = '📷 Scan Plat';
  }
}

// ---- 5. Ambil snapshot dari video kamera ----
function captureFromVideo() {
  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas;
}

// ---- 6. Kontrol tombol ----
btnScan.addEventListener('click', async () => {
  if (isBusy) return;

  if (usingUploadedImage) {
    // Sumber gambar dari file yang di-upload
    captureCanvas.width = previewImg.naturalWidth;
    captureCanvas.height = previewImg.naturalHeight;
    captureCtx.drawImage(previewImg, 0, 0);
    await runOcr(captureCanvas);
  } else {
    if (!cameraAvailable) {
      alert('Kamera tidak tersedia. Coba pakai tombol Upload Foto.');
      return;
    }
    const canvas = captureFromVideo();
    await runOcr(canvas);
  }
});

btnUpload.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    previewImg.src = evt.target.result;
    previewImg.style.display = 'block';
    video.style.display = 'none';
    usingUploadedImage = true;
    resultPanel.classList.remove('show');
    btnRetry.classList.remove('show');
    setStatus('Foto siap', 'ready');
  };
  reader.readAsDataURL(file);
});

btnRetry.addEventListener('click', () => {
  resultPanel.classList.remove('show');
  btnRetry.classList.remove('show');
  matchBadge.textContent = '';
  matchBadge.className = '';
  matchInfo.textContent = '';
  if (usingUploadedImage) {
    // Balik ke mode kamera
    usingUploadedImage = false;
    previewImg.style.display = 'none';
    video.style.display = 'block';
    fileInput.value = '';
  }
  setStatus('Aktif', 'ready');
});

// ---- 7. Inisialisasi ----
async function init() {
  try {
    await startCamera();

    setStatus('Memuat OCR...', 'busy');
    await loadOcrEngine();

    loadingEl.classList.add('hidden');
    setStatus(cameraAvailable ? 'Aktif' : 'Mode Upload', cameraAvailable ? 'ready' : '');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('Service worker gagal daftar:', err);
      });
    }
  } catch (err) {
    console.error('Init error:', err);
    setStatus('Error', 'error');
    loadingEl.classList.add('hidden');
  }
}

init();

// =====================================================================
// DATABASE LOKAL (tersimpan di HP kamu sendiri, lewat localStorage)
// Catatan: ini BUKAN database server sungguhan (MySQL dll) - datanya
// cuma ada di browser HP ini, hilang kalau cache di-clear. Cocok buat
// demo/prototipe cepat sebelum lanjut ke database beneran di Demo 2.
// =====================================================================

function getDb() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.warn('Gagal baca database lokal:', e);
    return [];
  }
}

function saveDb(list) {
  localStorage.setItem(DB_KEY, JSON.stringify(list));
}

function normalizePlate(text) {
  // Samakan format biar "L 2104 XS" == "L2104XS" pas dicocokkan
  return text.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function renderDataList() {
  const list = getDb();
  if (list.length === 0) {
    dataListEl.innerHTML = '<div id="data-empty">Belum ada data kendaraan.<br>Tambahkan lewat form di atas.</div>';
    return;
  }
  dataListEl.innerHTML = '';
  list.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = 'data-item';
    el.innerHTML = `
      <div class="di-info">
        <div class="di-plat">${item.plat}</div>
        <div class="di-nama">${item.nama}</div>
        <div class="di-nim">${item.nim || '-'}</div>
      </div>
      <button class="di-delete" data-idx="${idx}">Hapus</button>
    `;
    dataListEl.appendChild(el);
  });

  dataListEl.querySelectorAll('.di-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const current = getDb();
      current.splice(idx, 1);
      saveDb(current);
      renderDataList();
    });
  });
}

btnTambahData.addEventListener('click', () => {
  const plat = inputPlat.value.trim();
  const nama = inputNama.value.trim();
  const nim = inputNim.value.trim();

  if (!plat || !nama) {
    alert('Plat nomor dan nama wajib diisi.');
    return;
  }

  const current = getDb();
  current.push({ plat: plat.toUpperCase(), nama, nim });
  saveDb(current);

  inputPlat.value = '';
  inputNama.value = '';
  inputNim.value = '';
  renderDataList();
});

// ---- Cocokkan hasil OCR ke database ----
function matchPlateToDb(ocrText) {
  const normalizedOcr = normalizePlate(ocrText);
  if (!normalizedOcr) return null;

  const list = getDb();
  return list.find((item) => normalizePlate(item.plat) === normalizedOcr) || null;
}

// ---- Tab switching ----
tabScan.addEventListener('click', () => {
  tabScan.classList.add('active');
  tabData.classList.remove('active');
  dataView.classList.remove('show');
});

tabData.addEventListener('click', () => {
  tabData.classList.add('active');
  tabScan.classList.remove('active');
  dataView.classList.add('show');
  renderDataList();
});

renderDataList();
