const elements = {
  dropZone: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  chooseButton: document.querySelector("#chooseButton"),
  viewer: document.querySelector("#viewer"),
  fileName: document.querySelector("#fileName"),
  changeFile: document.querySelector("#changeFile"),
  mainCanvas: document.querySelector("#mainCanvas"),
  timeline: document.querySelector("#timeline"),
  currentTime: document.querySelector("#currentTime"),
  totalTime: document.querySelector("#totalTime"),
  overlayFrame: document.querySelector("#overlayFrame"),
  overlayTime: document.querySelector("#overlayTime"),
  previousFrame: document.querySelector("#previousFrame"),
  nextFrame: document.querySelector("#nextFrame"),
  playPause: document.querySelector("#playPause"),
  playIcon: document.querySelector("#playIcon"),
  pauseIcon: document.querySelector("#pauseIcon"),
  thumbnails: document.querySelector("#thumbnails"),
  videoMeta: document.querySelector("#videoMeta"),
  downloadVideo: document.querySelector("#downloadVideo"),
  exportStatus: document.querySelector("#exportStatus"),
  exportText: document.querySelector("#exportText"),
  exportPercent: document.querySelector("#exportPercent"),
  exportProgress: document.querySelector("#exportProgress"),
  message: document.querySelector("#message"),
};

const state = {
  video: null,
  currentFrame: 0,
  speed: 0.1,
  playing: false,
  timer: null,
};

function readFourCC(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function findFourCC(view, code, start = 0) {
  const bytes = [...code].map((character) => character.charCodeAt(0));
  for (let offset = start; offset <= view.byteLength - 4; offset += 1) {
    if (
      view.getUint8(offset) === bytes[0] &&
      view.getUint8(offset + 1) === bytes[1] &&
      view.getUint8(offset + 2) === bytes[2] &&
      view.getUint8(offset + 3) === bytes[3]
    ) {
      return offset;
    }
  }
  return -1;
}

function parseAvi(buffer) {
  const view = new DataView(buffer);
  if (readFourCC(view, 0) !== "RIFF" || readFourCC(view, 8) !== "AVI ") {
    throw new Error("Il file selezionato non è un contenitore AVI valido.");
  }

  const avih = findFourCC(view, "avih");
  const movi = findFourCC(view, "movi");
  const vids = findFourCC(view, "vids");
  if (avih < 0 || movi < 0 || vids < 0) {
    throw new Error("Non riesco a leggere la struttura del video AVI.");
  }

  const microsecondsPerFrame = view.getUint32(avih + 8, true);
  const declaredFrames = view.getUint32(avih + 24, true);
  const width = view.getUint32(avih + 40, true);
  const height = view.getUint32(avih + 44, true);
  const streamHeaderStart = vids - 8;
  const streamHeaderSize = view.getUint32(streamHeaderStart + 4, true);
  const streamFormat = findFourCC(view, "strf", streamHeaderStart + 8 + streamHeaderSize);
  const compression = streamFormat >= 0 ? readFourCC(view, streamFormat + 24) : "";
  const bitCount = streamFormat >= 0 ? view.getUint16(streamFormat + 22, true) : 0;

  if (!["IYUV", "I420"].includes(compression)) {
    throw new Error(
      `Questo prototipo supporta AVI IYUV/I420. Il video selezionato usa il codec "${compression || "sconosciuto"}".`,
    );
  }

  const expectedFrameSize = width * height * 1.5;
  const frames = [];
  let offset = movi + 4;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    if (/^\d\ddb$/.test(chunkId) || /^\d\ddc$/.test(chunkId)) {
      if (chunkSize < expectedFrameSize || offset + 8 + chunkSize > view.byteLength) {
        throw new Error("Uno dei fotogrammi del video risulta incompleto.");
      }
      frames.push(new Uint8Array(buffer, offset + 8, expectedFrameSize));
    }
    if (chunkId === "idx1") break;
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (!frames.length) {
    throw new Error("Nel file non sono stati trovati fotogrammi video.");
  }

  return {
    width,
    height,
    frames,
    declaredFrames,
    fps: 1_000_000 / microsecondsPerFrame,
    frameDuration: microsecondsPerFrame / 1_000_000,
    duration: frames.length * microsecondsPerFrame / 1_000_000,
    compression,
    bitCount,
  };
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function renderI420(frame, video, canvas, targetWidth = video.width) {
  const scale = Math.min(1, targetWidth / video.width);
  const outputWidth = Math.round(video.width * scale);
  const outputHeight = Math.round(video.height * scale);
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const context = canvas.getContext("2d", { alpha: false });
  const image = context.createImageData(outputWidth, outputHeight);
  const yPlaneSize = video.width * video.height;
  const chromaWidth = Math.ceil(video.width / 2);
  const chromaHeight = Math.ceil(video.height / 2);
  const uOffset = yPlaneSize;
  const vOffset = uOffset + chromaWidth * chromaHeight;

  for (let outputY = 0; outputY < outputHeight; outputY += 1) {
    const sourceY = Math.min(video.height - 1, Math.floor(outputY / scale));
    for (let outputX = 0; outputX < outputWidth; outputX += 1) {
      const sourceX = Math.min(video.width - 1, Math.floor(outputX / scale));
      const yValue = frame[sourceY * video.width + sourceX];
      const chromaIndex = Math.floor(sourceY / 2) * chromaWidth + Math.floor(sourceX / 2);
      const uValue = frame[uOffset + chromaIndex] - 128;
      const vValue = frame[vOffset + chromaIndex] - 128;

      const c = Math.max(0, yValue - 16);
      const pixel = (outputY * outputWidth + outputX) * 4;
      image.data[pixel] = clampByte((298 * c + 409 * vValue + 128) >> 8);
      image.data[pixel + 1] = clampByte((298 * c - 100 * uValue - 208 * vValue + 128) >> 8);
      image.data[pixel + 2] = clampByte((298 * c + 516 * uValue + 128) >> 8);
      image.data[pixel + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function setCurrentFrame(index) {
  if (!state.video) return;
  state.currentFrame = Math.max(0, Math.min(state.video.frames.length - 1, index));
  renderI420(state.video.frames[state.currentFrame], state.video, elements.mainCanvas);

  const time = state.currentFrame * state.video.frameDuration;
  elements.timeline.value = state.currentFrame;
  elements.currentTime.textContent = formatTime(time);
  elements.overlayTime.textContent = formatTime(time);
  elements.overlayFrame.textContent =
    `FRAME ${String(state.currentFrame + 1).padStart(2, "0")} / ${state.video.frames.length}`;

  elements.thumbnails.querySelectorAll(".thumbnail").forEach((thumbnail, thumbnailIndex) => {
    thumbnail.classList.toggle("is-active", thumbnailIndex === state.currentFrame);
  });
  elements.thumbnails.children[state.currentFrame]?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: "nearest",
  });
}

function createThumbnails() {
  elements.thumbnails.replaceChildren();
  state.video.frames.forEach((frame, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail";
    button.setAttribute("aria-label", `Vai al fotogramma ${index + 1}`);

    const canvas = document.createElement("canvas");
    const label = document.createElement("span");
    label.textContent = String(index + 1).padStart(2, "0");
    renderI420(frame, state.video, canvas, 320);
    button.append(canvas, label);
    button.addEventListener("click", () => {
      stopPlayback();
      setCurrentFrame(index);
    });
    elements.thumbnails.append(button);
  });
}

function setPlayingUi(isPlaying) {
  state.playing = isPlaying;
  elements.playIcon.classList.toggle("is-hidden", isPlaying);
  elements.pauseIcon.classList.toggle("is-hidden", !isPlaying);
  elements.playPause.setAttribute("aria-label", isPlaying ? "Pausa" : "Riproduci");
}

function stopPlayback() {
  window.clearTimeout(state.timer);
  state.timer = null;
  setPlayingUi(false);
}

function scheduleNextFrame() {
  if (!state.playing || !state.video) return;
  state.timer = window.setTimeout(() => {
    if (state.currentFrame >= state.video.frames.length - 1) {
      stopPlayback();
      return;
    }
    setCurrentFrame(state.currentFrame + 1);
    scheduleNextFrame();
  }, (state.video.frameDuration / state.speed) * 1000);
}

function togglePlayback() {
  if (state.playing) {
    stopPlayback();
    return;
  }
  if (state.currentFrame >= state.video.frames.length - 1) {
    setCurrentFrame(0);
  }
  setPlayingUi(true);
  scheduleNextFrame();
}

function showError(error) {
  stopPlayback();
  elements.message.textContent = error instanceof Error ? error.message : String(error);
  elements.message.classList.remove("is-hidden");
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function selectRecordingType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function exportSlowVideo() {
  if (!state.video || elements.downloadVideo.disabled) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    showError("Questo browser non supporta l'esportazione video. Prova con Chrome o Edge aggiornato.");
    return;
  }

  stopPlayback();
  elements.message.classList.add("is-hidden");
  elements.downloadVideo.disabled = true;
  elements.exportStatus.classList.remove("is-hidden");
  elements.exportText.textContent = "Creazione del video rallentato…";
  elements.exportProgress.value = 0;
  elements.exportPercent.textContent = "0%";

  const exportCanvas = document.createElement("canvas");
  const stream = exportCanvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mimeType = selectRecordingType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond: 8_000_000,
  });
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  const stopped = new Promise((resolve, reject) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(recorder.error), { once: true });
  });

  try {
    recorder.start();
    const frameDelay = (state.video.frameDuration / state.speed) * 1000;
    for (let index = 0; index < state.video.frames.length; index += 1) {
      renderI420(state.video.frames[index], state.video, exportCanvas);
      track.requestFrame();
      const percent = Math.round(((index + 1) / state.video.frames.length) * 100);
      elements.exportProgress.value = percent;
      elements.exportPercent.textContent = `${percent}%`;
      await wait(frameDelay);
    }
    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
    const baseName = elements.fileName.textContent.replace(/\.[^.]+$/, "");
    const speedLabel = state.speed === 0.033 ? "30x" : `${Math.round(1 / state.speed)}x`;
    downloadBlob(blob, `${baseName}-rallentato-${speedLabel}.webm`);
    elements.exportText.textContent = "Video pronto. Download avviato.";
  } catch (error) {
    if (recorder.state !== "inactive") recorder.stop();
    showError(error);
    elements.exportText.textContent = "Esportazione non riuscita.";
  } finally {
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    elements.downloadVideo.disabled = false;
    window.setTimeout(() => elements.exportStatus.classList.add("is-hidden"), 4000);
  }
}

async function loadFile(file) {
  if (!file) return;
  elements.message.classList.add("is-hidden");
  stopPlayback();
  try {
    const buffer = await file.arrayBuffer();
    state.video = parseAvi(buffer);
    state.currentFrame = 0;
    elements.fileName.textContent = file.name;
    elements.timeline.max = state.video.frames.length - 1;
    elements.totalTime.textContent = formatTime(state.video.duration);
    elements.videoMeta.textContent =
      `${state.video.width} × ${state.video.height} · ${state.video.frames.length} frame · ${state.video.fps.toFixed(2)} fps · ${state.video.compression}`;
    createThumbnails();
    setCurrentFrame(0);
    elements.dropZone.classList.add("is-hidden");
    elements.viewer.classList.remove("is-hidden");
  } catch (error) {
    showError(error);
  } finally {
    elements.fileInput.value = "";
  }
}

elements.chooseButton.addEventListener("click", () => elements.fileInput.click());
elements.changeFile.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
elements.playPause.addEventListener("click", togglePlayback);
elements.downloadVideo.addEventListener("click", exportSlowVideo);
elements.previousFrame.addEventListener("click", () => {
  stopPlayback();
  setCurrentFrame(state.currentFrame - 1);
});
elements.nextFrame.addEventListener("click", () => {
  stopPlayback();
  setCurrentFrame(state.currentFrame + 1);
});
elements.timeline.addEventListener("input", (event) => {
  stopPlayback();
  setCurrentFrame(Number(event.target.value));
});
document.querySelectorAll('input[name="speed"]').forEach((input) => {
  input.addEventListener("change", (event) => {
    state.speed = Number(event.target.value);
    if (state.playing) {
      window.clearTimeout(state.timer);
      scheduleNextFrame();
    }
  });
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
});
elements.dropZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));

document.addEventListener("keydown", (event) => {
  if (!state.video || ["INPUT", "BUTTON"].includes(document.activeElement.tagName)) return;
  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === "ArrowLeft") {
    stopPlayback();
    setCurrentFrame(state.currentFrame - 1);
  } else if (event.code === "ArrowRight") {
    stopPlayback();
    setCurrentFrame(state.currentFrame + 1);
  }
});
