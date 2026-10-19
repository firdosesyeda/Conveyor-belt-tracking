const input = document.getElementById('videoInput');
const uploadLayout = document.getElementById('uploadLayout');
const continueButton = document.getElementById('analyzeButton');
const trackButton = document.getElementById('trackObjectsButton');
const zoneEditor = document.getElementById('zoneEditor');
const zoneCanvas = document.getElementById('zoneCanvas');
const zoneSourceVideo = document.getElementById('zoneSourceVideo');
const inputVideo = document.getElementById('inputVideo');
const outputVideo = document.getElementById('outputVideo');
outputVideo.addEventListener('error', () => {
  document.getElementById('processingMessage').textContent = 'The browser could not play this output. Reinstall the video dependencies and analyze again.';
  document.getElementById('outputVideoReady').textContent = 'OUTPUT PLAYBACK ERROR';
  document.getElementById('outputVideoReady').classList.remove('active');
});
const processingPanel = document.getElementById('processingPanel');
const videoResults = document.getElementById('videoResults');
const toast = document.getElementById('toast');
let currentFile = null;
let localPreviewUrl = null;
let zones = [];
let draftZone = null;
let pollTimer = null;
let trackedVideoUrl = null;
let zoneFrameReady = false;
const zoneColors = ['#32a778', '#de9847', '#8d79c5', '#4f9bc7', '#c46876', '#4eaaa7'];

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

function setStage(stage) {
  document.getElementById('analysis').hidden = stage === 3;
  uploadLayout.hidden = stage !== 1;
  zoneEditor.hidden = stage !== 2;
  processingPanel.hidden = stage !== 3;
  document.getElementById('stepNumber').textContent = String(stage).padStart(2, '0');
  document.getElementById('stepName').textContent = ['VIDEO INPUT', 'COUNTING ZONES', 'OBJECT TRACKING'][stage - 1];
  document.getElementById('stepTitle').textContent = [
    'Choose a conveyor video',
    'Mark where boxes should be counted',
    'Tracking your conveyor video',
  ][stage - 1];
}

function selectFile(file) {
  if (!file) return;
  if (!/\.(mp4|mov|avi|mkv|webm|m4v)$/i.test(file.name)) {
    showToast('Choose an MP4, MOV, AVI, MKV, WEBM, or M4V video.');
    return;
  }
  if (file.size > 2 * 1024 * 1024 * 1024) {
    showToast('This video is larger than the 2 GB upload limit.');
    return;
  }

  currentFile = file;
  zoneFrameReady = false;
  zones = [];
  draftZone = null;
  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileSize').textContent = file.size < 1024 * 1024
    ? `${Math.max(1, Math.round(file.size / 1024))} KB`
    : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  document.getElementById('selectedFile').hidden = false;
  continueButton.disabled = false;
  const downloadButton = document.getElementById('downloadVideo');
  downloadButton.disabled = true;
  delete downloadButton.dataset.url;
  if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
  localPreviewUrl = URL.createObjectURL(file);
  zoneSourceVideo.onloadeddata = () => {
    zoneFrameReady = true;
    document.getElementById('zoneCanvasEmpty').textContent = 'Frame ready — click Add zone to begin.';
    drawZoneCanvas();
    renderZoneList();
  };
  zoneSourceVideo.onerror = () => {
    zoneFrameReady = false;
    document.getElementById('zoneCanvasEmpty').textContent = 'Could not read this video. Try MP4 or WEBM.';
    renderZoneList();
  };
  zoneSourceVideo.src = localPreviewUrl;
  zoneSourceVideo.load();
  zoneCanvas.width = 0;
  zoneCanvas.height = 0;
  document.getElementById('zoneCanvasEmpty').hidden = false;
  document.getElementById('zoneCanvasEmpty').textContent = 'Loading a video frame…';
  renderZoneList();
  videoResults.hidden = true;
  processingPanel.hidden = true;
  setStage(1);
}

input.addEventListener('change', () => selectFile(input.files[0]));
document.getElementById('browseButton').addEventListener('click', (event) => {
  event.stopPropagation();
  input.click();
});
document.getElementById('dropZone').addEventListener('click', (event) => {
  if (event.target.id !== 'browseButton') input.click();
});
document.getElementById('dropZone').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    input.click();
  }
});
['dragenter', 'dragover'].forEach((type) => document.getElementById('dropZone').addEventListener(type, (event) => {
  event.preventDefault();
  event.currentTarget.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((type) => document.getElementById('dropZone').addEventListener(type, (event) => {
  event.preventDefault();
  event.currentTarget.classList.remove('dragging');
}));
document.getElementById('dropZone').addEventListener('drop', (event) => selectFile(event.dataTransfer.files[0]));

continueButton.addEventListener('click', () => {
  if (!currentFile) return;
  setStage(2);
});
document.getElementById('backToVideoButton').addEventListener('click', () => setStage(1));

function zoneCanvasPoint(event) {
  const rect = zoneCanvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function drawZoneCanvas() {
  if (!zoneFrameReady || !zoneSourceVideo.videoWidth || !zoneSourceVideo.videoHeight) return;
  zoneCanvas.width = zoneSourceVideo.videoWidth;
  zoneCanvas.height = zoneSourceVideo.videoHeight;
  document.getElementById('zoneCanvasEmpty').hidden = true;
  const ctx = zoneCanvas.getContext('2d');
  ctx.clearRect(0, 0, zoneCanvas.width, zoneCanvas.height);
  ctx.drawImage(zoneSourceVideo, 0, 0, zoneCanvas.width, zoneCanvas.height);

  const drawPolygon = (zone, index, isDraft = false) => {
    if (!zone.points.length) return;
    const color = zoneColors[index % zoneColors.length];
    const points = zone.points.map((point) => ({ x: point.x * zoneCanvas.width, y: point.y * zoneCanvas.height }));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
    if (!isDraft && points.length >= 3) {
      ctx.closePath();
      ctx.fillStyle = `${color}35`;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, zoneCanvas.width / 500);
    ctx.setLineDash(isDraft ? [zoneCanvas.width / 100, zoneCanvas.width / 160] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    points.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(5, zoneCanvas.width / 180), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(2, zoneCanvas.width / 500);
      ctx.stroke();
    });
    const labelPoint = points.reduce((top, point) => point.y < top.y ? point : top, points[0]);
    ctx.font = `600 ${Math.max(14, zoneCanvas.width / 70)}px DM Sans, sans-serif`;
    const textWidth = ctx.measureText(zone.name).width;
    const labelY = Math.max(zoneCanvas.height / 20, labelPoint.y);
    ctx.fillStyle = color;
    ctx.fillRect(labelPoint.x, labelY - zoneCanvas.height / 18, textWidth + 18, zoneCanvas.height / 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(zone.name, labelPoint.x + 9, labelY - zoneCanvas.height / 45);
  };
  zones.forEach((zone, index) => drawPolygon(zone, index));
  if (draftZone) drawPolygon(draftZone, zones.length, true);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function renderZoneList() {
  const list = document.getElementById('zoneList');
  document.getElementById('addZoneButton').disabled = !zoneFrameReady;
  document.getElementById('finishZoneButton').disabled = !draftZone || draftZone.points.length < 3;
  document.getElementById('undoPointButton').disabled = !draftZone || !draftZone.points.length;
  document.getElementById('clearZonesButton').disabled = !zones.length && !draftZone;
  trackButton.disabled = zones.length === 0 || Boolean(draftZone);
  const draftLabel = document.getElementById('zoneDraftLabel');
  draftLabel.hidden = !draftZone;
  if (draftZone) draftLabel.innerHTML = `Drawing <b>${escapeHtml(draftZone.name)}</b> · ${draftZone.points.length} points`;
  const rows = zones.map((zone, index) => `<div class="zone-list-row"><span class="zone-result-mark" style="--zone-color:${zoneColors[index % zoneColors.length]}"></span><span>${escapeHtml(zone.name)}</span><small>${zone.points.length} POINTS</small><button type="button" data-remove-zone="${escapeHtml(zone.id)}" aria-label="Remove ${escapeHtml(zone.name)}">×</button></div>`).join('');
  list.innerHTML = rows || '<div class="zone-list-empty">Add at least one zone to count boxes in the area you choose.</div>';
  list.querySelectorAll('[data-remove-zone]').forEach((button) => button.addEventListener('click', () => {
    zones = zones.filter((zone) => zone.id !== button.dataset.removeZone);
    renderZoneList();
    drawZoneCanvas();
  }));
}

document.getElementById('addZoneButton').addEventListener('click', () => {
  if (!zoneFrameReady) return showToast('Wait for the video frame to load before adding a zone.');
  if (draftZone) return showToast('Finish the current polygon before adding another zone.');
  if (zones.length >= 12) return showToast('You can create up to 12 zones.');
  draftZone = { id: `zone-${Date.now()}`, name: `Zone ${zones.length + 1}`, points: [] };
  renderZoneList();
  drawZoneCanvas();
});
document.getElementById('finishZoneButton').addEventListener('click', () => {
  if (!draftZone || draftZone.points.length < 3) return;
  zones.push(draftZone);
  draftZone = null;
  renderZoneList();
  drawZoneCanvas();
});
document.getElementById('undoPointButton').addEventListener('click', () => {
  if (draftZone?.points.length) draftZone.points.pop();
  renderZoneList();
  drawZoneCanvas();
});
document.getElementById('clearZonesButton').addEventListener('click', () => {
  zones = [];
  draftZone = null;
  renderZoneList();
  drawZoneCanvas();
});
zoneCanvas.addEventListener('click', (event) => {
  if (!draftZone) return showToast('Click Add zone before drawing on the frame.');
  if (!zoneCanvas.width || !zoneCanvas.height) return;
  draftZone.points.push(zoneCanvasPoint(event));
  renderZoneList();
  drawZoneCanvas();
});

trackButton.addEventListener('click', startTracking);

async function startTracking() {
  if (!currentFile || !zones.length || draftZone) return;
  trackButton.disabled = true;
  document.getElementById('resultError').hidden = true;
  document.getElementById('resultActions').hidden = true;
  document.getElementById('processingTitle').textContent = 'Tracking boxes through your zones';
  document.getElementById('processingMessage').textContent = 'Uploading the video and preparing the detector.';
  document.getElementById('processingBadge').textContent = '● PROCESSING';
  document.getElementById('resultProgressFill').style.width = '0%';
  document.getElementById('resultProgressPercent').textContent = '0%';
  videoResults.hidden = true;
  setStage(3);
  try {
    const form = new FormData();
    form.append('video', currentFile);
    form.append('zones', JSON.stringify(zones));
    form.append('imgsz', document.getElementById('inferenceSize').value);
    const response = await fetch('/api/analyze', { method: 'POST', body: form });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not start tracking.');
    pollJob(job.id);
  } catch (error) {
    showTrackingError(error.message);
  }
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not read tracking status.');
    if (job.state === 'error') throw new Error(job.message || 'Tracking failed.');
    if (job.state === 'complete') {
      document.getElementById('resultProgressFill').style.width = '100%';
      document.getElementById('resultProgressPercent').textContent = '100%';
      document.getElementById('processingTitle').textContent = 'Tracking complete';
      document.getElementById('processingMessage').textContent = `${job.frames_processed.toLocaleString()} frames processed · annotated video is ready.`;
      document.getElementById('processingBadge').textContent = '● VIDEO READY';
      document.getElementById('outputVideoReady').textContent = '● OUTPUT READY';
      document.getElementById('outputVideoReady').classList.add('active');
      inputVideo.src = localPreviewUrl;
      inputVideo.hidden = false;
      document.querySelector('.input-empty').hidden = true;
      videoResults.hidden = false;
      outputVideo.hidden = false;
      document.querySelector('.output-empty').hidden = true;
      outputVideo.src = `${job.video_url}?t=${Date.now()}`;
      outputVideo.load();
      document.getElementById('videoCaption').textContent = `${job.filename} · boxes and track IDs are drawn on the frames`;
      const downloadButton = document.getElementById('downloadVideo');
      downloadButton.disabled = false;
      downloadButton.dataset.url = job.video_url;
      document.getElementById('resultActions').hidden = false;
      document.getElementById('editZonesButton').hidden = true;
      return;
    }
    const progress = Math.max(0, Math.min(99, job.progress || 0));
    document.getElementById('resultProgressFill').style.width = `${progress}%`;
    document.getElementById('resultProgressPercent').textContent = `${progress}%`;
    document.getElementById('processingMessage').textContent = job.message || 'Processing the video.';
    pollTimer = setTimeout(() => pollJob(jobId), 1100);
  } catch (error) {
    showTrackingError(error.message);
  }
}

function showTrackingError(message) {
  const error = document.getElementById('resultError');
  error.textContent = message;
  error.hidden = false;
  document.getElementById('processingTitle').textContent = 'Tracking could not finish';
  document.getElementById('processingBadge').textContent = '● ERROR';
  document.getElementById('resultActions').hidden = false;
  document.getElementById('editZonesButton').hidden = false;
  trackButton.disabled = false;
}

document.getElementById('editZonesButton').addEventListener('click', () => {
  document.getElementById('resultError').hidden = true;
  setStage(2);
});

document.getElementById('downloadVideo').addEventListener('click', () => {
  const button = document.getElementById('downloadVideo');
  const url = button.dataset.url;
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = `${currentFile.name.replace(/\.[^.]+$/, '')}-tracked.mp4`;
  document.body.appendChild(link);
  link.click();
  link.remove();
});

document.getElementById('newVideoButton').addEventListener('click', () => {
  if (pollTimer) clearTimeout(pollTimer);
  if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
  currentFile = null;
  zones = [];
  draftZone = null;
  input.value = '';
  inputVideo.removeAttribute('src');
  inputVideo.load();
  zoneSourceVideo.pause();
  zoneSourceVideo.removeAttribute('src');
  zoneSourceVideo.load();
  zoneFrameReady = false;
  outputVideo.pause();
  outputVideo.removeAttribute('src');
  outputVideo.load();
  document.getElementById('selectedFile').hidden = true;
  document.getElementById('resultActions').hidden = true;
  document.getElementById('resultError').hidden = true;
  document.getElementById('downloadVideo').disabled = true;
  delete document.getElementById('downloadVideo').dataset.url;
  document.querySelector('.input-empty').hidden = false;
  document.querySelector('.output-empty').hidden = false;
  document.getElementById('inputVideoReady').classList.remove('active');
  document.getElementById('outputVideoReady').classList.remove('active');
  continueButton.disabled = true;
  zoneCanvas.width = 0;
  zoneCanvas.height = 0;
  document.getElementById('zoneCanvasEmpty').hidden = false;
  document.getElementById('zoneCanvasEmpty').textContent = 'Upload a video to load its frame.';
  renderZoneList();
  setStage(1);
});

window.addEventListener('resize', drawZoneCanvas);
renderZoneList();
setStage(1);
