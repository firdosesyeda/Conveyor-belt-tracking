const input = document.getElementById('videoInput');
const dropZone = document.getElementById('dropZone');
const browseButton = document.getElementById('browseButton');
const analyzeButton = document.getElementById('analyzeButton');
const selectedFile = document.getElementById('selectedFile');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');
const progressArea = document.getElementById('progressArea');
const errorBanner = document.getElementById('errorBanner');
const inputVideo = document.getElementById('inputVideo');
const outputVideo = document.getElementById('outputVideo');
const toast = document.getElementById('toast');
let currentFile = null;
let currentAnalytics = null;
let pollTimer = null;
let localPreviewUrl = null;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function selectFile(file) {
  if (!file) return;
  const allowed = /\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(file.name);
  if (!allowed) {
    showToast('Choose an MP4, MOV, AVI, MKV, WEBM, or M4V video.');
    return;
  }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    showToast('This video is larger than the 2 GB upload limit.');
    return;
  }
  currentFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  selectedFile.hidden = false;
  analyzeButton.disabled = false;
  errorBanner.hidden = true;
  progressArea.hidden = true;
  currentAnalytics = null;
  document.getElementById('exportButton').disabled = true;
  if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
  localPreviewUrl = URL.createObjectURL(file);
  inputVideo.src = localPreviewUrl;
  inputVideo.hidden = false;
  document.querySelector('.input-empty').hidden = true;
  outputVideo.pause();
  outputVideo.removeAttribute('src');
  outputVideo.load();
  outputVideo.hidden = true;
  document.querySelector('.output-empty').hidden = false;
  document.getElementById('downloadVideo').disabled = true;
  document.getElementById('inputVideoCaption').textContent = file.name;
  document.getElementById('inputVideoReady').textContent = '● SOURCE READY';
  document.getElementById('inputVideoReady').classList.add('active');
  document.getElementById('outputVideoReady').textContent = '● WAITING';
  document.getElementById('outputVideoReady').classList.remove('active');
  resetAnalytics();
}

function resetAnalytics() {
  document.getElementById('totalProducts').textContent = '—';
  document.getElementById('peakProducts').textContent = '—';
  document.getElementById('throughput').textContent = '—';
  document.getElementById('confidence').textContent = '—';
  document.getElementById('avgDuration').textContent = '—';
  document.getElementById('classNote').textContent = 'Tracked product IDs';
  document.getElementById('analysisStatus').classList.remove('live');
  document.getElementById('analysisStatus').innerHTML = '<i></i> AWAITING VIDEO';
  document.getElementById('chartDuration').textContent = '—';
  document.getElementById('chartMidpoint').textContent = '—';
  document.getElementById('chartEnd').textContent = '—';
  document.getElementById('chartEmpty').hidden = false;
  document.getElementById('distributionEmpty').hidden = false;
  document.getElementById('distributionContent').hidden = true;
  document.getElementById('trackCount').textContent = '0 OBJECTS';
  document.getElementById('tracksBody').innerHTML = '<tr class="empty-row"><td colspan="4"><span class="table-empty-icon">⌖</span>Track details will show here after analysis.</td></tr>';
  drawChart([]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

browseButton.addEventListener('click', (event) => {
  event.stopPropagation();
  input.click();
});
dropZone.addEventListener('click', (event) => {
  if (event.target !== browseButton) input.click();
});
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    input.click();
  }
});
input.addEventListener('change', () => selectFile(input.files[0]));
['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((type) => dropZone.addEventListener(type, (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', (event) => selectFile(event.dataTransfer.files[0]));

analyzeButton.addEventListener('click', async () => {
  if (!currentFile) return;
  if (pollTimer) clearTimeout(pollTimer);
  analyzeButton.disabled = true;
  errorBanner.hidden = true;
  progressArea.hidden = false;
  document.getElementById('progressSpinner').classList.remove('done');
  setProgress(0, 'Uploading video…', 'Preparing the analysis job.');
  document.getElementById('analysisStatus').classList.add('live');
  document.getElementById('analysisStatus').innerHTML = '<i></i> ANALYSIS RUNNING';
  try {
    const form = new FormData();
    form.append('video', currentFile);
    const response = await fetch('/api/analyze', { method: 'POST', body: form });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not start analysis.');
    pollJob(job.id);
  } catch (error) {
    showError(error.message);
    analyzeButton.disabled = false;
  }
});

function setProgress(value, title, message) {
  document.getElementById('progressFill').style.width = `${value}%`;
  document.getElementById('progressPercent').textContent = `${value}%`;
  document.getElementById('progressTitle').textContent = title;
  document.getElementById('progressMessage').textContent = message || '';
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not read analysis status.');
    if (job.state === 'error') throw new Error(job.message || 'Video analysis failed.');
    if (job.state === 'complete') {
      setProgress(100, 'Analysis complete', 'Tracked video and analytics are ready.');
      document.getElementById('progressSpinner').classList.add('done');
      document.getElementById('analysisStatus').innerHTML = '<i></i> ANALYSIS COMPLETE';
      document.getElementById('exportButton').disabled = false;
      currentAnalytics = job.analytics;
      renderAnalytics(job.analytics);
      outputVideo.src = `${job.video_url}?t=${Date.now()}`;
      outputVideo.hidden = false;
      document.querySelector('.output-empty').hidden = true;
      document.getElementById('videoCaption').textContent = `${job.filename} · boxes and persistent track IDs`;
      document.getElementById('outputVideoReady').textContent = '● OUTPUT READY';
      document.getElementById('outputVideoReady').classList.add('active');
      document.getElementById('downloadVideo').disabled = false;
      document.getElementById('downloadVideo').dataset.url = job.video_url;
      analyzeButton.disabled = false;
      showToast('Video tracking is complete.');
      return;
    }
    const queued = job.state === 'queued';
    setProgress(job.progress || 0, queued ? 'Queued for analysis' : 'Tracking products…', job.message || 'Processing your video.');
    pollTimer = setTimeout(() => pollJob(jobId), 1100);
  } catch (error) {
    showError(error.message);
    analyzeButton.disabled = false;
  }
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
  document.getElementById('analysisStatus').classList.remove('live');
  document.getElementById('analysisStatus').innerHTML = '<i></i> ANALYSIS ERROR';
  showToast('Analysis could not be completed.');
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderAnalytics(data) {
  document.getElementById('totalProducts').textContent = data.total_products.toLocaleString();
  document.getElementById('peakProducts').textContent = data.max_simultaneous.toLocaleString();
  document.getElementById('throughput').textContent = data.throughput_per_minute.toLocaleString();
  document.getElementById('confidence').textContent = (data.avg_confidence * 100).toFixed(1);
  document.getElementById('avgDuration').textContent = `${data.avg_track_seconds.toFixed(1)} s`;
  document.getElementById('classNote').textContent = `${data.total_detections.toLocaleString()} detections · ${data.processed_frames.toLocaleString()} frames`;
  document.getElementById('chartDuration').textContent = `${data.video_fps} FPS`;
  const end = data.video_duration_seconds || 0;
  document.getElementById('chartMidpoint').textContent = formatTime(end / 2);
  document.getElementById('chartEnd').textContent = formatTime(end);
  document.getElementById('chartEmpty').hidden = data.timeline.length > 0;
  drawChart(data.timeline);
  renderDistribution(data.class_breakdown, data.total_products);
  renderTracks(data.tracks);
}

function renderDistribution(classes, total) {
  const entries = Object.entries(classes || {}).sort((a, b) => b[1] - a[1]);
  const empty = document.getElementById('distributionEmpty');
  const content = document.getElementById('distributionContent');
  if (!entries.length) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  document.getElementById('donutTotal').textContent = total.toLocaleString();
  const colors = ['#54a77b', '#e0a85e', '#8296c7', '#cc7c6a', '#8f7cb8'];
  let angle = 0;
  const stops = entries.map(([, count], index) => {
    const start = angle;
    angle += total ? (count / total) * 360 : 0;
    return `${colors[index % colors.length]} ${start}deg ${angle}deg`;
  });
  document.getElementById('donutChart').style.background = `conic-gradient(${stops.join(',')})`;
  document.getElementById('classLegend').innerHTML = entries.map(([name, count], index) => `<div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(name)}</span><b>${count.toLocaleString()}</b></div>`).join('');
}

function renderTracks(tracks) {
  const list = [...(tracks || [])].sort((a, b) => b.first_seen_seconds - a.first_seen_seconds).slice(0, 8);
  document.getElementById('trackCount').textContent = `${(tracks || []).length.toLocaleString()} OBJECTS`;
  if (!list.length) {
    document.getElementById('tracksBody').innerHTML = '<tr class="empty-row"><td colspan="4"><span class="table-empty-icon">⌖</span>No tracked products were found in this video.</td></tr>';
    return;
  }
  document.getElementById('tracksBody').innerHTML = list.map((track) => `<tr><td class="track-id">#${track.id}</td><td><span class="class-pill">${escapeHtml(track.class)}</span></td><td class="confidence-cell">${(track.confidence * 100).toFixed(0)}%</td><td>${track.duration_seconds.toFixed(1)}s</td></tr>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function drawChart(timeline) {
  const canvas = document.getElementById('flowChart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  const left = 5, right = 5, top = 6, bottom = 11;
  const chartW = width - left - right;
  const chartH = height - top - bottom;
  ctx.strokeStyle = '#edf1ee';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  for (let i = 0; i < 3; i++) {
    const y = top + (chartH / 2) * i + .5;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
  }
  ctx.setLineDash([]);
  if (!timeline.length) return;
  const bins = timeline.length > 60
    ? Array.from({ length: 60 }, (_, i) => {
      const start = Math.floor(i * timeline.length / 60);
      const end = Math.floor((i + 1) * timeline.length / 60);
      return timeline.slice(start, Math.max(start + 1, end)).reduce((sum, item) => sum + item.new_tracks, 0);
    })
    : timeline.map((item) => item.new_tracks);
  const max = Math.max(1, ...bins);
  const points = bins.map((value, index) => ({
    x: left + (bins.length === 1 ? chartW / 2 : (index / (bins.length - 1)) * chartW),
    y: top + chartH - (value / max) * chartH,
  }));
  const gradient = ctx.createLinearGradient(0, top, 0, height);
  gradient.addColorStop(0, 'rgba(69,167,122,.20)');
  gradient.addColorStop(1, 'rgba(69,167,122,0)');
  ctx.beginPath();
  ctx.moveTo(points[0].x, top + chartH);
  points.forEach((point) => ctx.lineTo(point.x, point.y));
  ctx.lineTo(points[points.length - 1].x, top + chartH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
  ctx.strokeStyle = '#459e72';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  if (points.length <= 12) {
    points.forEach((point) => { ctx.beginPath(); ctx.arc(point.x, point.y, 2, 0, Math.PI * 2); ctx.fillStyle = '#459e72'; ctx.fill(); });
  }
}

document.getElementById('exportButton').addEventListener('click', () => {
  if (!currentAnalytics) return;
  const report = {
    generated_at: new Date().toISOString(),
    source_video: currentFile?.name || '',
    ...currentAnalytics,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${(currentFile?.name || 'conveyor-analysis').replace(/\.[^.]+$/, '')}-analytics.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

document.getElementById('downloadVideo').addEventListener('click', () => {
  const url = document.getElementById('downloadVideo').dataset.url;
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(currentFile?.name || 'conveyor-video').replace(/\.[^.]+$/, '')}-tracked.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

window.addEventListener('resize', () => { if (currentAnalytics) drawChart(currentAnalytics.timeline); });
drawChart([]);
