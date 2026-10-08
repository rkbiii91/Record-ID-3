const photoInput = document.getElementById('photo-input');
const preview = document.getElementById('preview');
const statusEl = document.getElementById('status');
const errorBanner = document.getElementById('error-banner');
const captureSection = document.getElementById('capture-section');
const detailSection = document.getElementById('detail-section');
const scanAnotherBtn = document.getElementById('scan-another-btn');

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
  detailSection.hidden = true;
  captureSection.hidden = false;
  statusEl.hidden = true;
  preview.hidden = true;
  photoInput.value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearError() {
  errorBanner.hidden = true;
}

function setStatus(text) {
  statusEl.hidden = false;
  statusEl.textContent = text;
}

// Phone photos can be 3-10MB+, which risks hitting upload limits and slows everything
// down. Resize to a sane max dimension and re-encode as JPEG before sending anywhere.
function compressImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round(height * (maxDim / width));
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round(width * (maxDim / height));
        height = maxDim;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  if (!file) return;
  clearError();

  try {
    const imageDataUrl = await compressImage(file);
    preview.src = imageDataUrl;
    preview.hidden = false;
    setStatus('Reading the label…');

    // Step 1: identify
    const idRes = await fetch('/api/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl })
    });
    const extracted = await idRes.json();
    if (!idRes.ok) {
      const reason = extracted?.error ? ` (${extracted.error})` : '';
      showError(`Could not read the label${reason}`);
      return;
    }

    const trackTitles = Array.isArray(extracted.track_titles) ? extracted.track_titles.filter(Boolean) : [];
    const hasUsableInfo = extracted.artist || extracted.release_title || trackTitles.length || extracted.catalog_number;
    if (!hasUsableInfo) {
      showError('Could not make out enough text on the label — try a closer photo.');
      return;
    }

    // 1 song on the label = 45 single, 2+ = LP album. Used to favor matching-format results.
    const formatGuess = trackTitles.length === 1 ? 'single' : trackTitles.length > 1 ? 'album' : '';
    // Prefer an explicitly printed release title; for singles, the one song title IS effectively the title.
    const titleForSearch = extracted.release_title || (formatGuess === 'single' ? trackTitles[0] : '');

    // Step 2: auto-lookup on Discogs (search + pick best match + full details, one call)
    setStatus('Looking it up on Discogs…');
    const params = new URLSearchParams();
    if (extracted.artist) params.set('artist', extracted.artist);
    if (titleForSearch) params.set('title', titleForSearch);
    if (extracted.catalog_number) params.set('catno', extracted.catalog_number);
    if (extracted.year) params.set('year', extracted.year);
    if (formatGuess) params.set('format', formatGuess);

    const lookupRes = await fetch(`/api/auto-lookup?${params.toString()}`);
    if (lookupRes.status === 404) {
      const what = extracted.artist || titleForSearch || 'this record';
      showError(`Read the label fine (${what}) but couldn't find a match on Discogs.`);
      return;
    }
    if (!lookupRes.ok) {
      showError('Discogs lookup failed — try again in a moment.');
      return;
    }
    const release = await lookupRes.json();
    renderResults(release);
  } catch (err) {
    console.error(err);
    showError('Something went wrong — try again.');
  }
});

function groupSides(tracklist) {
  const order = [];
  const sides = {};
  (tracklist || []).forEach(t => {
    const pos = (t.position || '').trim();
    const letterMatch = pos.match(/^([A-Za-z]+)/);
    const key = letterMatch ? `Side ${letterMatch[1].toUpperCase()}` : 'Tracklist';
    if (!sides[key]) { sides[key] = []; order.push(key); }
    sides[key].push(t);
  });
  return order.map(key => ({ side: key, tracks: sides[key] }));
}

function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{6,})/,
    /youtube\.com\/watch\?v=([a-zA-Z0-9_-]{6,})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function renderResults(r) {
  captureSection.hidden = true;
  detailSection.hidden = false;

  document.getElementById('detail-artist').textContent = r.artist || 'Unknown Artist';
  document.getElementById('detail-label').textContent = r.label || 'Unknown';
  document.getElementById('detail-year').textContent = r.year || 'Unknown';
  document.getElementById('detail-catno').textContent = r.catalog_number || 'Unknown';

  const statsUrl = r.marketplace?.stats_url || r.discogs_release_url;
  const haveEl = document.getElementById('detail-have');
  haveEl.textContent = r.community?.have ?? '—';
  haveEl.href = statsUrl;

  const wantEl = document.getElementById('detail-want');
  wantEl.textContent = r.community?.want ?? '—';
  wantEl.href = statsUrl;

  document.getElementById('detail-rating').textContent =
    r.community?.rating_average != null ? `${r.community.rating_average.toFixed(1)} / 5` : 'No ratings yet';

  const ratingCountEl = document.getElementById('detail-rating-count');
  ratingCountEl.textContent = r.community?.rating_count ?? '—';
  ratingCountEl.href = statsUrl;

  const price = r.marketplace?.lowest_price;
  document.getElementById('detail-price').textContent = price
    ? `${price} ${r.marketplace.currency || ''}`.trim()
    : 'No copies currently listed';
  document.getElementById('detail-forsale').textContent = r.marketplace?.num_for_sale ?? 0;
  document.getElementById('detail-marketplace-link').href = r.marketplace?.marketplace_url || r.discogs_release_url;
  document.getElementById('detail-sellhistory-link').href = r.marketplace?.sell_history_url || statsUrl;

  const suggTable = document.getElementById('price-suggestions-table');
  suggTable.innerHTML = '';
  if (r.price_suggestions && r.price_suggestions.length) {
    r.price_suggestions.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${s.condition}</td><td>${s.price != null ? `${s.price} ${s.currency || ''}`.trim() : '—'}</td>`;
      suggTable.appendChild(tr);
    });
  } else {
    suggTable.innerHTML = '<tr><td colspan="2" style="color:var(--muted);">No price suggestions available for this release.</td></tr>';
  }

  const sidesEl = document.getElementById('sides');
  sidesEl.innerHTML = '';
  groupSides(r.tracklist).forEach(group => {
    const div = document.createElement('div');
    div.className = 'side-block';
    const list = group.tracks.map(t => `<li>${t.title}${t.duration ? ' — ' + t.duration : ''}</li>`).join('');
    div.innerHTML = `<span class="side-title">${group.side}</span><ol>${list}</ol>`;
    sidesEl.appendChild(div);
  });

  const videosEl = document.getElementById('videos');
  videosEl.innerHTML = '';
  if (!r.videos || !r.videos.length) {
    videosEl.innerHTML = '<p style="color:var(--muted);font-size:0.9rem;">No videos listed on this release page.</p>';
  } else {
    r.videos.forEach(v => {
      const ytId = extractYouTubeId(v.url);
      const wrap = document.createElement('div');
      if (ytId) {
        wrap.innerHTML = `
          <div class="video-wrap">
            <iframe src="https://www.youtube.com/embed/${ytId}" allowfullscreen loading="lazy"></iframe>
          </div>
          <p class="video-title">${v.title || ''}</p>
        `;
      } else {
        wrap.innerHTML = `<p><a href="${v.url}" target="_blank" rel="noopener">${v.title || v.url}</a></p>`;
      }
      videosEl.appendChild(wrap);
    });
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

scanAnotherBtn.addEventListener('click', () => {
  detailSection.hidden = true;
  captureSection.hidden = false;
  preview.hidden = true;
  statusEl.hidden = true;
  photoInput.value = '';
  clearError();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Register service worker for installability (PWA)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
