"""A user gate page, built from a manifest.

    uv run python .claude/scripts/gate-page.py <manifest.json> <output.html>
    uv run --with pillow --with numpy python .claude/scripts/gate-page.py ...   (a manifest with bases)
    uv run python .claude/scripts/gate-page.py <manifest.json> <output.html> --linked

A gate hands the owner rendered options and takes back picks by option name. The manifest states
the gate and this script states nothing about any one gate, so a round of any plan builds its page
by writing a manifest beside its evidence. The manifest's keys:

  title        the page's title.
  intro        optional: what the owner reads first, a string or a list of paragraphs.
  tables       optional: measurements every decision shares, shown after the intro. Each has a
               caption, a header (a list of column names) and rows (lists of cells).
  references   optional: frames that are not options, shown after the tables, such as the mock of
               a look that left the page, each a caption and a file relative to the manifest.
  decisions    the decisions in the order they are read. Each has an id, a name, its options (id,
               name, and optionally a tooltip shown over the option's button), its shots (id and
               name), and its axes: the decisions whose picks select its frame, its own among
               them. A decision whose look depends on another's pick names that one as an
               axis, and the two render as combinations.
               An option may name a group. A decision's options then all do, and the options of
               one group are listed one after another. Each group's buttons take a row of their
               own beside the group's name, and the table of options has a row with that name
               above the group's rows, so a long list of options reads as families.
               Optional sliders: scene variables the owner scrubs, such as a light's angle. Each
               has an id, a name, its stops (id and name) in order, optionally the stop it opens
               on as default (else its first), and wrap: true when its last stop leads back to
               its first, as an angle's does; Play then loops round it, and otherwise bounces
               between its ends. A shot lists the sliders it answers under the key sliders.
               A shot may state crops, {"boxes": [[left, top, right, bottom], ...], "scale": 5},
               to read small parts large: the stage then shows only those boxes of the frame,
               stacked, each pixel enlarged scale times (1 when left out), and an animated frame
               holds still. The whole frame takes a shot of its own.
               A shot may state width, the CSS pixels across that its frame is shown at, to judge
               a frame at the size its viewer sees it, such as a clip in a phone's feed. A shot
               has crops or a width, not both.
               A shot whose frames are videos may state frame, the video frame its stage opens on
               as the page's counter numbers it, from 1 (1 when left out), such as the moment the
               decision turns on.
               Optional tables: tables only this decision needs, shaped as the page's tables and
               shown under its note.
               Optional references: frames only this decision needs, shaped as the page's
               references and shown under its tables, such as the look the owner judged before,
               which an option that changed it is read against.
               Optional stage: the id of another decision. This decision's option buttons then
               show on that decision's stage, above its own, and that decision lists this one
               among its axes. This decision has no axes, shots, sliders or frames. Decisions that
               combine into one look are read on one stage this way.
               Optional when, on a decision that joins another's stage: per decision id, the
               option ids under which this decision's pick changes the look, such as a light's
               color under every placement but the one that leaves the figure unlit. Under any
               other pick its buttons grey out and the picks text says it does not apply.
               A decision with nothing to render leaves out shots and axes: it shows its table and
               its option buttons, and no stage.
  pricing      per decision and option, what the option changes, what it costs, the measured
               reading behind it, and its tradeoffs: what picking it gives up against the other
               options, or takes on that they avoid.
  preselected  per decision, the recommended option, which the page opens on.
  frames       one entry per rendered combination and shot: the decision, the picks it was
               rendered under (one per axis), the shot, and the file, relative to the manifest,
               a .png or .webp, still or animated, a .gif, or a video, an .mp4 or .webm, which
               needs ffprobe on the PATH to build. A video's shot has no crops and no sliders, and
               its videos share one frame count and rate, since the page compares them frame by
               frame. A frame of a shot with sliders states its stop on each of them under stops.
               An optional caption states the frame's facts after its picks. An optional base
               names another still frame's file of the same size: the page then stores only the
               16 pixel tiles in which the two differ, which lets a page hold hundreds of stills
               that share most of their pixels. A video is no base and has none. A .gif quantized
               frame by frame moves pixels that hold still in its source, so an animation a look
               is judged by is a video or an animated .png or .webp. Only a video holds on a frame
               the owner picks; an animated .png or .webp plays as it is.

By default the page is one dark self-contained file with every frame embedded, on disk and
published nowhere. A browser cannot open a page of some hundreds of megabytes, so --linked writes one that loads each
frame from beside the manifest instead and ignores bases: the page then works only next to its
frames.
Picks are page-wide: one stage per decision that has its own, option buttons above the image and
one button per shot below it, then the shot's sliders, each slider with a button that plays through
its stops. A video holds still on one frame. The scrubber under it, its Previous frame and Next frame
buttons, and the arrow keys on the stage last clicked pick that frame. Play plays it muted in a
loop. The frame holds per shot as picks change, so a click between two options compares them on
that frame, and an option clicked during play plays on from the same frame. A click on a frame
zooms in on that spot. On a zoomed frame the wheel zooms in and out, back to the whole frame, and a
drag moves it. A stage keeps its zoom across picks, shots and stops.
The picks are restated as text with a copy button. A combination no round rendered shows its
nearest rendered frame, the one agreeing on the decision's own pick and on the most other axes and
stops, and says so.
"""
import base64
import functools
import html
import io
import json
import os
import pathlib
import subprocess
import sys
import urllib.parse

TILE = 16
# Frame pixels between a shot's stacked crops.
CROP_GAP = 4
VIDEO_TYPES = {'.mp4': 'video/mp4', '.webm': 'video/webm'}
# Screen pixels per frame pixel that a click on a stage zooms to, and the most the wheel zooms to.
CLICK_ZOOM = 4
ZOOM_MAX = 32
# A pricing row's keys, each a column of a decision's table under its header.
PRICING = {'changes': 'Changes', 'costs': 'Costs', 'reading': 'Reading', 'tradeoffs': 'Trade-offs'}

STYLE = '''
<style>
  :root { color-scheme: dark; }
  body { background: #121417; color: #d8dbe0; font: 14px/1.45 system-ui, sans-serif; margin: 0; padding: 24px 32px 64px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  h2 { font-size: 18px; margin: 40px 0 8px; border-top: 1px solid #2a2e35; padding-top: 24px; }
  p { max-width: 110ch; }
  .note { color: #9aa1ab; font-size: 13px; }
  table { border-collapse: collapse; margin: 8px 0 16px; max-width: 1400px; }
  th, td { border: 1px solid #2a2e35; padding: 6px 10px; vertical-align: top; text-align: left; font-size: 13px; }
  th { background: #1a1d22; }
  tr.recommended td:first-child::after { content: ' (recommended)'; color: #9aa1ab; }
  .row { margin: 6px 0; }
  .row .label { color: #9aa1ab; font-size: 13px; margin-right: 8px; }
  .row.group { margin: 0; }
  .row.group .label { display: inline-block; min-width: 14ch; }
  button { background: #1e2228; color: #d8dbe0; border: 1px solid #3a3f48; border-radius: 4px; padding: 4px 10px; margin: 0 4px 4px 0; cursor: pointer; font-size: 13px; }
  button.on { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .host { container-type: inline-size; }
  .stage { margin: 4px 0; background: #0b0c0e; border: 1px solid #2a2e35; display: inline-block; max-width: 100%; }
  .stage:not(.zoomed) { min-width: min(100%, var(--hold-w, 0px)); min-height: var(--hold-h, 0px); }
  .stage img, .stage canvas, .stage video { display: block; max-width: 100%; image-rendering: auto; }
  .stage canvas.crops { image-rendering: pixelated; }
  .stage.fit img, .stage.fit canvas, .stage.fit video { cursor: zoom-in; }
  .stage.zoomed { display: block; overflow: auto; height: 85vh; cursor: grab; }
  .stage.zoomed.dragging { cursor: grabbing; }
  .stage.zoomed img, .stage.zoomed canvas, .stage.zoomed video { max-width: none; }
  .stage.pixels img, .stage.pixels canvas, .stage.pixels video { image-rendering: pixelated; }
  .frame-controls { display: flex; gap: 8px; align-items: center; margin: 4px 0; }
  .frame-controls button { margin: 0; }
  .frame-controls input { width: min(420px, 40vw); }
  .frame-controls output { font-size: 13px; font-variant-numeric: tabular-nums; }
  .caption { color: #9aa1ab; font-size: 12px; margin: 2px 0 8px; }
  .caption.nearest { color: #e6c14f; }
  .sliders { display: grid; grid-template-columns: max-content minmax(160px, 420px) 12ch max-content; gap: 4px 12px; align-items: center; margin: 6px 0 12px; }
  .sliders label { font-size: 13px; color: #9aa1ab; }
  .sliders output { font-size: 13px; }
  .sliders button { margin: 0; }
  .picks { position: sticky; top: 0; z-index: 2; background: #1a1d22; border: 1px solid #2a2e35; border-radius: 6px; padding: 8px 12px; margin: 0 0 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .picks code { background: #0b0c0e; padding: 2px 6px; border-radius: 3px; }
</style>
'''

SCRIPT = '''
<script>
(function () {
  const store = JSON.parse(document.getElementById('frame-store').textContent);
  const gate = JSON.parse(document.getElementById('gate').textContent);
  const picks = Object.assign({}, gate.preselected);
  const shots = {};
  const stops = {};
  const shotById = {};
  const sliderById = {};
  // Per stage and shot, the video frame its clips hold, and per stage whether its clip plays.
  const clipFrames = {};
  const clipPlaying = {};
  const staged = gate.decisions.filter(function (d) { return !d.stage && d.shots && d.shots.length; });
  staged.forEach(function (d) {
    shots[d.id] = d.shots[0].id;
    stops[d.id] = {};
    shotById[d.id] = {};
    sliderById[d.id] = {};
    clipFrames[d.id] = {};
    d.shots.forEach(function (s) { shotById[d.id][s.id] = s; clipFrames[d.id][s.id] = (s.frame || 1) - 1; });
    (d.sliders || []).forEach(function (s) { sliderById[d.id][s.id] = s; stops[d.id][s.id] = s.default || s.stops[0].id; });
  });
  const names = {};
  const titles = {};
  gate.decisions.forEach(function (d) {
    titles[d.id] = d.name;
    names[d.id] = {};
    d.options.forEach(function (o) { names[d.id][o.id] = o.name; });
  });
  const byId = {};
  gate.decisions.forEach(function (d) { byId[d.id] = d; });
  // Whether a decision's pick changes the look under the other picks (its when).
  function applies(decision) {
    return Object.keys(decision.when || {}).every(function (other) { return decision.when[other].indexOf(picks[other]) >= 0; });
  }

  function shotSliders(decision) { return shotById[decision.id][shots[decision.id]].sliders || []; }

  function find(decision, shot, chosen) {
    chosen = chosen || picks;
    const own = shotSliders(decision);
    const candidates = gate.frames.filter(function (f) {
      return f.decision === decision.id && f.shot === shot && f.picks[decision.id] === chosen[decision.id];
    });
    let best = null, bestScore = -1;
    candidates.forEach(function (f) {
      const score = decision.axes.filter(function (axis) { return f.picks[axis] === chosen[axis]; }).length
        + own.filter(function (s) { return f.stops && f.stops[s] === stops[decision.id][s]; }).length;
      if (score > bestScore) { best = f; bestScore = score; }
    });
    return best === null ? null : { frame: best, exact: bestScore === decision.axes.length + own.length };
  }
  function spell(decision, framePicks, frameStops) {
    // Several decisions can share an option name, so each pick is named with its decision.
    const parts = decision.axes.map(function (axis) {
      return (decision.axes.length > 1 ? titles[axis] + ': ' : '') + names[axis][framePicks[axis]];
    });
    shotSliders(decision).forEach(function (id) {
      const slider = sliderById[decision.id][id];
      const stop = slider.stops.find(function (s) { return s.id === frameStops[id]; });
      if (stop) parts.push(slider.name + ' ' + stop.name);
    });
    return parts.join(', ');
  }

  // Decoded frames, as canvases, the most recently used last.
  const decoded = new Map();
  const DECODED_KEPT = 64;
  // A linked page stores each frame's address, an embedded one its bytes.
  function extension(file) { return '.' + file.split('.').pop().toLowerCase(); }
  function isVideo(file) { return extension(file) in gate.videoTypes; }
  function frameSource(file) {
    if (gate.linked) return store[file];
    return 'data:image/' + extension(file).slice(1) + ';base64,' + store[file];
  }
  // An embedded video plays from a blob, made once, which seeks without decoding its text again.
  const blobs = {};
  function clipSource(file) {
    if (gate.linked) return store[file];
    if (!blobs[file]) {
      const text = atob(store[file]);
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
      blobs[file] = URL.createObjectURL(new Blob([bytes], { type: gate.videoTypes[extension(file)] }));
    }
    return blobs[file];
  }
  function loadImage(source) {
    return new Promise(function (resolve, reject) {
      const image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = reject;
      image.src = source;
    });
  }
  function keep(file, canvas) {
    decoded.delete(file);
    decoded.set(file, canvas);
    while (decoded.size > DECODED_KEPT) decoded.delete(decoded.keys().next().value);
    return canvas;
  }
  async function frameCanvas(file) {
    if (decoded.has(file)) return keep(file, decoded.get(file));
    const entry = store[file];
    let canvas;
    if (typeof entry === 'string') {
      const image = await loadImage(frameSource(file));
      canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
    } else {
      const base = await frameCanvas(entry.base);
      canvas = document.createElement('canvas');
      canvas.width = base.width;
      canvas.height = base.height;
      const context = canvas.getContext('2d');
      context.drawImage(base, 0, 0);
      if (entry.at.length > 0) {
        const atlas = await loadImage('data:image/webp;base64,' + entry.tiles);
        const across = Math.floor(atlas.naturalWidth / entry.tile);
        entry.at.forEach(function (at, i) {
          const sx = (i % across) * entry.tile, sy = Math.floor(i / across) * entry.tile;
          const w = Math.min(entry.tile, canvas.width - at[0]), h = Math.min(entry.tile, canvas.height - at[1]);
          context.clearRect(at[0], at[1], w, h);
          context.drawImage(atlas, sx, sy, w, h, at[0], at[1], w, h);
        });
      }
    }
    return keep(file, canvas);
  }
  function draw(target, source, crops) {
    const context = target.getContext('2d');
    if (!crops) {
      target.width = source.width;
      target.height = source.height;
      target.className = '';
      context.drawImage(source, 0, 0);
      return;
    }
    const gap = gate.cropGap, scale = crops.scale || 1;
    const width = Math.max.apply(null, crops.boxes.map(function (b) { return b[2] - b[0]; }));
    const height = crops.boxes.reduce(function (sum, b) { return sum + b[3] - b[1]; }, 0) + gap * (crops.boxes.length - 1);
    target.width = width * scale;
    target.height = height * scale;
    target.className = 'crops';
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#3c4048';
    context.fillRect(0, 0, target.width, target.height);
    let y = 0;
    crops.boxes.forEach(function (b) {
      const w = b[2] - b[0], h = b[3] - b[1];
      context.drawImage(source, b[0], b[1], w, h, 0, y * scale, w * scale, h * scale);
      y += h + gap;
    });
  }

  // Per stage, its zoom, 0 for the frame unzoomed, as wide as it is or as the page, and the zoom it
  // showed unzoomed when it last left that. A zoom counts device pixels, so 1 shows each frame pixel as
  // one pixel of the screen at any display scaling.
  const zooms = {};
  const unzoomed = {};
  function stageOf(id) { return document.getElementById('stage-' + id).querySelector('.stage'); }
  function shown(stage) {
    return Array.prototype.find.call(stage.children, function (el) { return el.style.display !== 'none'; });
  }
  function natural(el) {
    if (el.tagName === 'IMG') return [el.naturalWidth, el.naturalHeight];
    if (el.tagName === 'VIDEO') return [el.videoWidth, el.videoHeight];
    return [el.width, el.height];
  }
  // The frame pixels across an element, which a shot's crops draw enlarged.
  function framePixels(decision, el) {
    const crops = shotById[decision.id][shots[decision.id]].crops;
    return natural(el)[0] / ((crops && crops.scale) || 1);
  }
  function size(decision) {
    const stage = stageOf(decision.id), zoom = zooms[decision.id] || 0;
    const width = shotById[decision.id][shots[decision.id]].width;
    stage.classList.toggle('fit', zoom === 0);
    stage.classList.toggle('zoomed', zoom > 0);
    stage.classList.toggle('pixels', zoom >= 2);
    Array.prototype.forEach.call(stage.children, function (el) {
      const across = framePixels(decision, el);
      el.style.width = zoom > 0 && across > 0 ? across * zoom / devicePixelRatio + 'px' : width ? width + 'px' : '';
    });
  }
  // Zooms a stage, keeping the frame pixel under the client point where it is.
  function zoomTo(decision, zoom, x, y) {
    const stage = stageOf(decision.id), el = shown(stage);
    if (!el || !natural(el)[0]) return;
    const before = el.getBoundingClientRect();
    const across = natural(el)[0];
    const fx = (x - before.left) / (before.width / across), fy = (y - before.top) / (before.width / across);
    if (!zooms[decision.id]) unzoomed[decision.id] = before.width * devicePixelRatio / framePixels(decision, el);
    zooms[decision.id] = zoom > 0 ? Math.min(gate.zoomMax, zoom) : 0;
    size(decision);
    if (!zooms[decision.id]) return;
    const after = stage.getBoundingClientRect(), scale = el.getBoundingClientRect().width / across;
    stage.scrollLeft = fx * scale - (x - after.left);
    stage.scrollTop = fy * scale - (y - after.top);
  }

  // Per stage, a video element per clip it showed, the most recently used last, so a click back to
  // an option shows its clip without loading it again. A stage keeps the clips of two shots, so the
  // clips of one shot, which it seeks together, never push each other out, and a click back to the
  // shot before finds its clips loaded.
  const videos = {};
  const kept = {};
  staged.forEach(function (d) { videos[d.id] = new Map(); kept[d.id] = 2 * d.options.length; });
  function videoOf(decision, file) {
    const clips = videos[decision.id];
    let video = clips.get(file);
    if (video) {
      clips.delete(file);
      clips.set(file, video);
      return video;
    }
    video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.display = 'none';
    video.dataset.file = file;
    video.addEventListener('loadedmetadata', function () { size(decision); });
    video.src = clipSource(file);
    stageOf(decision.id).appendChild(video);
    clips.set(file, video);
    for (const [old, el] of clips) {
      if (clips.size <= kept[decision.id]) break;
      if (el.style.display !== 'none') continue;
      el.removeAttribute('src');
      el.load();
      el.remove();
      clips.delete(old);
    }
    return video;
  }
  function lastFrame(file) { return gate.clips[file].frames - 1; }
  // A frame is sought at its middle, so the seek lands on it however the stream rounds its times.
  function seek(video, frame) {
    return new Promise(function (resolve, reject) {
      // An element that failed once fires no second error.
      if (video.error) { reject(video.error); return; }
      video.addEventListener('error', reject, { once: true });
      function done() {
        video.removeEventListener('error', reject);
        resolve();
      }
      function go() {
        const time = (frame + 0.5) / gate.clips[video.dataset.file].fps;
        if (!video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - time) < 1e-3) { done(); return; }
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = time;
      }
      if (video.readyState >= 1) { go(); return; }
      video.addEventListener('loadedmetadata', go, { once: true });
    });
  }
  // While a clip plays, its stage's frame is the frame on screen, read from each presented frame:
  // currentTime runs up to two frames behind it, so a pause read from currentTime steps back.
  // A stage follows one clip at a time, so a pause and a play do not leave two readers running.
  const followed = {};
  function follow(decision, video) {
    const before = followed[decision.id];
    if (before) before.video.cancelVideoFrameCallback(before.handle);
    function next() {
      followed[decision.id] = { video: video, handle: video.requestVideoFrameCallback(function (now, presented) {
        if (!clipPlaying[decision.id] || shownClip(decision) !== video) return;
        const clip = gate.clips[video.dataset.file];
        clipFrames[decision.id][shots[decision.id]] = Math.min(clip.frames - 1, Math.round(presented.mediaTime * clip.fps));
        clipControls(decision, video.dataset.file);
        next();
      }) };
    }
    next();
  }
  function shownClip(decision) {
    const el = shown(stageOf(decision.id));
    return el && el.tagName === 'VIDEO' ? el : null;
  }
  function clipControls(decision, file) {
    const row = document.getElementById('stage-' + decision.id).querySelector('.frame-controls');
    if (!row) return;
    // Hidden, not removed, so the shot buttons under it stay put.
    row.style.visibility = file ? '' : 'hidden';
    if (!file) return;
    const frame = clipFrames[decision.id][shots[decision.id]];
    const input = row.querySelector('input');
    input.max = String(lastFrame(file));
    input.value = String(frame);
    row.querySelector('output').textContent = 'Frame ' + (frame + 1) + ' of ' + gate.clips[file].frames;
    row.querySelector('button[data-clip-play]').textContent = clipPlaying[decision.id] ? 'Pause' : 'Play';
  }
  // Shows a clip at its stage's frame. The frame shown before stays until the clip has sought, so
  // the stage never goes blank between two options.
  function showClip(decision, file, token) {
    const stage = stageOf(decision.id);
    const target = videoOf(decision, file);
    if (clipPlaying[decision.id] && shownClip(decision) === target) return;
    const frame = clipFrames[decision.id][shots[decision.id]];
    if (!clipPlaying[decision.id]) target.pause();
    seek(target, frame).then(function () {
      if (tokens[decision.id] !== token) return;
      Array.prototype.forEach.call(stage.children, function (el) {
        if (el === target) return;
        el.style.display = 'none';
        if (el.tagName === 'VIDEO') el.pause();
      });
      target.style.display = '';
      if (clipPlaying[decision.id]) {
        // A pause before playback starts rejects play(), which is no fault.
        target.play().catch(function () {});
        follow(decision, target);
      }
      size(decision);
      clipControls(decision, file);
    }, function () {
      if (tokens[decision.id] !== token) return;
      // Nothing stays on the stage, so the option picked last is never shown another option's frame.
      Array.prototype.forEach.call(stage.children, function (el) {
        el.style.display = 'none';
        if (el.tagName === 'VIDEO') el.pause();
      });
      const caption = document.getElementById('stage-' + decision.id).querySelector('.caption');
      caption.textContent = 'This video could not be decoded: ' + file;
      caption.className = 'caption nearest';
      clipPlaying[decision.id] = false;
      clipControls(decision, file);
    });
    if (clipPlaying[decision.id]) return;
    // The other options' clips of this shot seek to the frame too, so a click to one shows it at once.
    decision.options.forEach(function (option) {
      if (option.id === picks[decision.id]) return;
      const chosen = Object.assign({}, picks);
      chosen[decision.id] = option.id;
      const other = find(decision, shots[decision.id], chosen);
      if (other && isVideo(other.frame.file)) {
        seek(videoOf(decision, other.frame.file), frame).catch(function () {});
      }
    });
    // Touches the shown clip again, so the preloads are evicted before it.
    videoOf(decision, file);
  }
  function setClipPlaying(decision, on) {
    const video = shownClip(decision);
    if (!video || !!clipPlaying[decision.id] === on) return;
    clipPlaying[decision.id] = on;
    if (on) {
      video.play().catch(function () {});
      follow(decision, video);
      clipControls(decision, video.dataset.file);
      return;
    }
    video.pause();
    // Seeks the paused clip to the middle of the last frame shown, the frame the counter names.
    render();
  }
  function stepClip(decision, delta) {
    const video = shownClip(decision);
    if (!video) return;
    setClipPlaying(decision, false);
    const shot = shots[decision.id];
    clipFrames[decision.id][shot] = Math.max(0, Math.min(lastFrame(video.dataset.file), clipFrames[decision.id][shot] + delta));
    render();
  }

  const tokens = {};
  function render() {
    staged.forEach(function (decision) {
      // Every pass takes a new token, so a decode still pending from an earlier pass never draws
      // over what this pass shows.
      const token = (tokens[decision.id] || 0) + 1;
      tokens[decision.id] = token;
      const box = document.getElementById('stage-' + decision.id);
      const shot = shotById[decision.id][shots[decision.id]];
      box.querySelectorAll('button[data-option]').forEach(function (b) { b.classList.toggle('on', picks[b.dataset.decision] === b.dataset.option); });
      box.querySelectorAll('button[data-shot]').forEach(function (b) { b.classList.toggle('on', shots[decision.id] === b.dataset.shot); });
      const own = shot.sliders || [];
      box.querySelectorAll('[data-slider-row]').forEach(function (el) { el.style.display = own.indexOf(el.dataset.sliderRow) >= 0 ? '' : 'none'; });
      box.querySelectorAll('input[data-slider]').forEach(function (input) {
        const slider = sliderById[decision.id][input.dataset.slider];
        const index = slider.stops.findIndex(function (s) { return s.id === stops[decision.id][slider.id]; });
        input.value = String(index);
        box.querySelector('output[data-slider="' + slider.id + '"]').textContent = slider.stops[index].name;
      });
      const found = find(decision, shots[decision.id]);
      const image = box.querySelector('img');
      const canvas = box.querySelector('canvas');
      const caption = box.querySelector('.caption');
      const isVideoFrame = found !== null && isVideo(found.frame.file);
      clipControls(decision, isVideoFrame ? found.frame.file : null);
      if (!isVideoFrame) {
        clipPlaying[decision.id] = false;
        box.querySelectorAll('video').forEach(function (video) { video.pause(); video.style.display = 'none'; });
      }
      if (found === null) {
        image.removeAttribute('src');
        image.style.display = '';
        canvas.style.display = 'none';
        caption.textContent = 'No round rendered this option on this shot.';
        caption.className = 'caption nearest';
        return;
      }
      caption.className = found.exact ? 'caption' : 'caption nearest';
      caption.textContent = (found.exact
        ? spell(decision, found.frame.picks, found.frame.stops || {}) + '.'
        : 'No round rendered ' + spell(decision, picks, stops[decision.id]) + '. Showing the nearest rendered frame: '
          + spell(decision, found.frame.picks, found.frame.stops || {}) + '.')
        + (found.frame.caption ? ' ' + found.frame.caption : '');
      const file = found.frame.file;
      if (isVideoFrame) {
        showClip(decision, file, token);
        return;
      }
      if (typeof store[file] === 'string' && own.length === 0 && !shot.crops) {
        // A browser plays an animated PNG or WebP as it is.
        image.src = frameSource(file);
        image.style.display = '';
        canvas.style.display = 'none';
        size(decision);
        return;
      }
      frameCanvas(file).then(function (source) {
        if (tokens[decision.id] !== token) return;
        draw(canvas, source, shot.crops);
        canvas.style.display = '';
        image.style.display = 'none';
        size(decision);
      }, function () {
        if (tokens[decision.id] !== token) return;
        canvas.style.display = 'none';
        caption.textContent = 'This frame could not be decoded: ' + file;
        caption.className = 'caption nearest';
      });
    });
    document.querySelectorAll('.unstaged button[data-option]').forEach(function (b) { b.classList.toggle('on', picks[b.dataset.decision] === b.dataset.option); });
    document.querySelectorAll('button[data-option]').forEach(function (b) {
      const d = byId[b.dataset.decision];
      b.disabled = !applies(d);
      b.title = b.disabled
        ? 'Does not apply under your answer to ' + Object.keys(d.when).map(function (other) { return '"' + byId[other].name + '"'; }).join(' and ') + '.'
        : (b.dataset.tooltip || '');
    });
    document.getElementById('picks-text').textContent = gate.decisions.map(function (d) {
      return d.name + ': ' + (applies(d) ? names[d.id][picks[d.id]] : 'does not apply');
    }).join('; ');
  }

  const sweeps = {};
  function stopSweep(decision) {
    const sweep = sweeps[decision];
    if (!sweep) return;
    clearInterval(sweep.timer);
    sweep.button.textContent = 'Play';
    delete sweeps[decision];
  }
  document.querySelectorAll('button[data-option]').forEach(function (b) {
    b.addEventListener('click', function () { picks[b.dataset.decision] = b.dataset.option; render(); });
  });
  document.querySelectorAll('button[data-shot]').forEach(function (b) {
    b.addEventListener('click', function () {
      const decision = b.dataset.decision;
      stopSweep(decision);
      setClipPlaying(staged.find(function (d) { return d.id === decision; }), false);
      shots[decision] = b.dataset.shot;
      render();
    });
  });
  document.querySelectorAll('input[data-slider]').forEach(function (input) {
    input.addEventListener('input', function () {
      const decision = input.dataset.decision;
      stopSweep(decision);
      stops[decision][input.dataset.slider] = sliderById[decision][input.dataset.slider].stops[Number(input.value)].id;
      render();
    });
  });
  document.querySelectorAll('button[data-play]').forEach(function (b) {
    b.addEventListener('click', function () {
      const decision = b.dataset.decision, id = b.dataset.play;
      const sweeping = sweeps[decision] && sweeps[decision].slider === id;
      stopSweep(decision);
      if (sweeping) return;
      const slider = sliderById[decision][id];
      const last = slider.stops.length - 1;
      let step = 1;
      b.textContent = 'Stop';
      sweeps[decision] = { slider: id, button: b, timer: setInterval(function () {
        const index = slider.stops.findIndex(function (s) { return s.id === stops[decision][id]; });
        let next;
        if (slider.wrap) {
          next = (index + 1) % slider.stops.length;
        } else {
          if (index + step > last || index + step < 0) step = -step;
          next = Math.max(0, Math.min(last, index + step));
        }
        stops[decision][id] = slider.stops[next].id;
        render();
      }, 450) };
    });
  });
  // The stage the owner last touched takes the arrow keys.
  let active = null;
  staged.forEach(function (decision) {
    const stage = stageOf(decision.id);
    const host = document.getElementById('stage-' + decision.id);
    host.addEventListener('pointerdown', function () { active = decision; });
    host.addEventListener('focusin', function () { active = decision; });
    const controls = host.querySelector('.frame-controls');
    if (controls) {
      controls.querySelector('button[data-clip-play]').addEventListener('click', function () { setClipPlaying(decision, !clipPlaying[decision.id]); });
      controls.querySelectorAll('button[data-clip-step]').forEach(function (b) {
        b.addEventListener('click', function () { stepClip(decision, Number(b.dataset.clipStep)); });
      });
      controls.querySelector('input').addEventListener('input', function (event) {
        // Read before the pause, whose render writes the playing frame back into the scrubber.
        const frame = Number(event.target.value);
        setClipPlaying(decision, false);
        clipFrames[decision.id][shots[decision.id]] = frame;
        render();
      });
    }
    stage.querySelector('img').addEventListener('load', function () { size(decision); });
    stage.addEventListener('click', function (event) {
      if (!zooms[decision.id] && event.target !== stage) zoomTo(decision, gate.zoomClick, event.clientX, event.clientY);
    });
    stage.addEventListener('wheel', function (event) {
      const zoom = zooms[decision.id];
      if (!zoom) return;
      event.preventDefault();
      // A line is about 16 pixels of scroll.
      const step = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      const next = zoom * Math.exp(-step * 0.002);
      // Zooming out past the unzoomed size goes back to it, and the wheel scrolls the page again.
      zoomTo(decision, step > 0 && next <= unzoomed[decision.id] ? 0 : next, event.clientX, event.clientY);
    }, { passive: false });
    let drag = null;
    stage.addEventListener('pointerdown', function (event) {
      if (!zooms[decision.id] || event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('dragging');
      event.preventDefault();
    });
    stage.addEventListener('pointermove', function (event) {
      if (!drag) return;
      stage.scrollLeft = drag.left - (event.clientX - drag.x);
      stage.scrollTop = drag.top - (event.clientY - drag.y);
    });
    ['pointerup', 'pointercancel'].forEach(function (type) {
      stage.addEventListener(type, function () { drag = null; stage.classList.remove('dragging'); });
    });
  });
  document.addEventListener('keydown', function (event) {
    // A focused scrubber steps itself.
    if (!active || event.target.tagName === 'INPUT' || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!delta || !shownClip(active)) return;
    event.preventDefault();
    stepClip(active, delta);
  });
  document.getElementById('picks-copy').addEventListener('click', function () { navigator.clipboard.writeText(document.getElementById('picks-text').textContent); });
  render();
})();
</script>
'''


def check(manifest, root):
    """A manifest that names an option, a shot, a stop or a file nothing else states builds a page
    that shows the wrong frame without saying so, so it is refused here."""
    decisions = {d['id']: d for d in manifest['decisions']}
    files = {f['file'] for f in manifest['frames']}
    for d in manifest['decisions']:
        options = {o['id'] for o in d['options']}
        sliders = {s['id']: {stop['id'] for stop in s['stops']} for s in d.get('sliders') or []}
        if d.get('stage'):
            host = decisions.get(d['stage'])
            if host is None or host.get('stage') or not host.get('shots'):
                raise SystemExit(f"{d['id']}: its stage names no decision that has a stage of its own.")
            if d['id'] not in host['axes']:
                raise SystemExit(f"{d['id']}: the decision whose stage it joins names it as no axis.")
            if d.get('shots') or d.get('sliders') or any(f['decision'] == d['id'] for f in manifest['frames']):
                raise SystemExit(f"{d['id']}: a decision on another's stage has no shots, sliders or frames.")
            for other, under in (d.get('when') or {}).items():
                if other not in decisions or not set(under) <= {o['id'] for o in decisions[other]['options']}:
                    raise SystemExit(f"{d['id']}: its when names {other}: {under}, which states no such decision or options.")
        elif d.get('when'):
            raise SystemExit(f"{d['id']}: only a decision on another's stage has a when.")
        elif not d.get('shots'):
            if d.get('axes') or d.get('sliders') or any(f['decision'] == d['id'] for f in manifest['frames']):
                raise SystemExit(f"{d['id']}: a decision with no shots has no axes, sliders or frames.")
        elif d['id'] not in d['axes']:
            raise SystemExit(f"{d['id']}: a decision is one of its own axes.")
        for axis in d.get('axes') or []:
            if axis not in decisions:
                raise SystemExit(f"{d['id']}: axis {axis} names no decision.")
        groups = [o.get('group') for o in d['options']]
        runs = [g for i, g in enumerate(groups) if i == 0 or g != groups[i - 1]]
        if any(groups) and (not all(groups) or len(runs) != len(set(runs))):
            raise SystemExit(f"{d['id']}: every option names a group, and a group's options are listed one after another.")
        if manifest['preselected'].get(d['id']) not in options:
            raise SystemExit(f"{d['id']}: the preselection names no option.")
        if set(manifest['pricing'].get(d['id'], {})) != options:
            raise SystemExit(f"{d['id']}: every option has one pricing row.")
        for o, row in manifest['pricing'][d['id']].items():
            if not all(row.get(key) for key in PRICING):
                raise SystemExit(f"{d['id']}: option {o}'s pricing row has no "
                                 f"{', '.join(key for key in PRICING if not row.get(key))}. "
                                 f"Give every pricing row {', '.join(PRICING)}.")
        for s in d.get('sliders') or []:
            if s.get('default', s['stops'][0]['id']) not in sliders[s['id']]:
                raise SystemExit(f"{d['id']}: slider {s['id']} opens on no stop of its own.")
        for shot in d.get('shots') or []:
            crops = shot.get('crops')
            width = shot.get('width')
            if width is not None and (type(width) is not int or width < 1 or crops is not None):
                raise SystemExit(
                    f"{d['id']}: shot {shot['id']}'s width is a whole number of pixels, on a shot with no crops.")
            if crops is not None:
                boxes = crops.get('boxes') if isinstance(crops, dict) else None
                scale = crops.get('scale', 1) if isinstance(crops, dict) else None
                if (not isinstance(boxes, list) or not boxes or type(scale) is not int or scale < 1
                        or any(not isinstance(b, list) or len(b) != 4 or any(type(v) is not int for v in b)
                               or not (0 <= b[0] < b[2] and 0 <= b[1] < b[3]) for b in boxes)):
                    raise SystemExit(
                        f"{d['id']}: shot {shot['id']}'s crops must be an object: boxes, a list of "
                        f"[left, top, right, bottom] in whole pixels with left below right and top "
                        f"below bottom, and optionally scale, a whole number from 1.")
            for slider in shot.get('sliders') or []:
                if slider not in sliders:
                    raise SystemExit(f"{d['id']}: shot {shot['id']} answers slider {slider}, which is not declared.")
    for r in (manifest.get('references') or []) + [r for d in manifest['decisions'] for r in d.get('references') or []]:
        if not (root / r['file']).is_file():
            raise SystemExit(f"{r['file']}: no such reference beside the manifest.")
        if is_video(r['file']):
            raise SystemExit(f"{r['file']}: a reference is a picture. A video is a frame of a decision.")
    for f in manifest['frames']:
        d = decisions.get(f['decision'])
        if d is None:
            raise SystemExit(f"{f['file']}: decision {f['decision']} is not declared.")
        if set(f['picks']) != set(d['axes']):
            raise SystemExit(f"{f['file']}: a frame states one pick per axis of its decision.")
        for axis, option in f['picks'].items():
            if option not in {o['id'] for o in decisions[axis]['options']}:
                raise SystemExit(f"{f['file']}: {axis} has no option {option}.")
        shot = next((s for s in d['shots'] if s['id'] == f['shot']), None)
        if shot is None:
            raise SystemExit(f"{f['file']}: {f['decision']} has no shot {f['shot']}.")
        sliders = {s['id']: {stop['id'] for stop in s['stops']} for s in d.get('sliders') or []}
        if set(f.get('stops') or {}) != set(shot.get('sliders') or []):
            raise SystemExit(f"{f['file']}: a frame states one stop per slider of its shot.")
        for slider, stop in (f.get('stops') or {}).items():
            if stop not in sliders[slider]:
                raise SystemExit(f"{f['file']}: slider {slider} has no stop {stop}.")
        if f.get('base') and f['base'] not in files:
            raise SystemExit(f"{f['file']}: its base {f['base']} is no frame's file.")
        if is_video(f['file']) and (shot.get('crops') or shot.get('sliders') or f.get('base')):
            raise SystemExit(f"{f['file']}: a video's shot has no crops and no sliders, and a video has no base.")
        if f.get('base') and is_video(f['base']):
            raise SystemExit(f"{f['file']}: its base {f['base']} is a video.")
        if not (root / f['file']).is_file():
            raise SystemExit(f"{f['file']}: no such frame beside the manifest.")
        if 'frame' in shot and not is_video(f['file']):
            raise SystemExit(f"{f['file']}: shot {f['shot']} states a frame, so it holds only videos, and this frame is a still.")
        if 'frame' in shot and (type(shot['frame']) is not int or not 1 <= shot['frame'] <= clip(root / f['file'])['frames']):
            raise SystemExit(f"{f['file']}: shot {f['shot']}'s frame is {shot['frame']!r}, and this video has "
                             f"{clip(root / f['file'])['frames']} frames. Give a whole number from 1 to that count.")
        width, height = size(root / f['file'])
        for box in (shot.get('crops') or {}).get('boxes') or []:
            if box[2] > width or box[3] > height:
                raise SystemExit(f"{f['file']}: shot {f['shot']}'s crop {box} reaches past the frame, which is {width}x{height}.")
    # The page shows frame n of a video at (n + 0.5) / fps and holds n across a shot's options.
    timings = {}
    for f in manifest['frames']:
        if is_video(f['file']):
            video = clip(root / f['file'])
            if video['offset'] >= 0.5:
                raise SystemExit(f"{f['file']}: a frame is shown {video['offset']:.2f} frames away from its place "
                                 f"at {video['fps']:g} fps, so the page would show it at the wrong moment. "
                                 'Encode it at a constant frame rate, starting at 0.')
            timings.setdefault((f['decision'], f['shot']), {})[f['file']] = (video['frames'], video['fps'])
    for (decision, shot), files in timings.items():
        if len(set(files.values())) > 1:
            listed = ', '.join(f"{file} {count} frames at {rate:g} fps" for file, (count, rate) in files.items())
            raise SystemExit(f"{decision}: shot {shot}'s videos differ in frame count or rate, so one frame "
                             f"shows them at different moments: {listed}. Render them at one rate and length, "
                             'or as animated .webp files, which each play at their own.')


def drawn_size(shot, frame_size):
    """The pixels a shot's frame takes on the stage: the frame's own, or its crops' stacked."""
    crops = shot.get('crops')
    if shot.get('width'):
        return shot['width'], round(frame_size[1] * shot['width'] / frame_size[0])
    if not crops:
        return frame_size
    boxes, scale = crops['boxes'], crops.get('scale', 1)
    return (max(b[2] - b[0] for b in boxes) * scale,
            (sum(b[3] - b[1] for b in boxes) + CROP_GAP * (len(boxes) - 1)) * scale)


def tiled(root, file, base):
    """The tiles of a frame that differ from its base's, packed into one lossless WebP."""
    import numpy as np
    from PIL import Image

    frame = np.asarray(Image.open(root / file).convert('RGBA'))
    under = np.asarray(Image.open(root / base).convert('RGBA'))
    if frame.shape != under.shape:
        raise SystemExit(f"{file}: its base {base} is another size.")
    height, width = frame.shape[:2]
    at = []
    for y in range(0, height, TILE):
        for x in range(0, width, TILE):
            if (frame[y:y + TILE, x:x + TILE] != under[y:y + TILE, x:x + TILE]).any():
                at.append([x, y])
    entry = {'base': base, 'tile': TILE, 'at': at, 'tiles': ''}
    if at:
        across = min(len(at), 64)
        atlas = np.zeros((-(-len(at) // across) * TILE, across * TILE, 4), np.uint8)
        for i, (x, y) in enumerate(at):
            part = frame[y:y + TILE, x:x + TILE]
            ty, tx = (i // across) * TILE, (i % across) * TILE
            atlas[ty:ty + part.shape[0], tx:tx + part.shape[1]] = part
        data = io.BytesIO()
        Image.fromarray(atlas, 'RGBA').save(data, 'WEBP', lossless=True, quality=100, method=4, exact=True)
        entry['tiles'] = base64.b64encode(data.getvalue()).decode('ascii')
    return entry


def is_video(file):
    return pathlib.PurePosixPath(file).suffix.lower() in VIDEO_TYPES


@functools.cache
def clip(path):
    """A video's width and height in pixels, its frame count, its frames per second, and the most
    any frame's time lies off its place at that rate, in frames, from ffprobe."""
    try:
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
             'stream=width,height,avg_frame_rate,r_frame_rate:packet=pts_time', '-of', 'json', str(path)],
            capture_output=True, text=True, check=True)
        data = json.loads(probe.stdout)
        stream = data['streams'][0]
        # A stream that states no average rate reads 0/0 there.
        rate = stream['avg_frame_rate'] if not stream['avg_frame_rate'].startswith('0/') else stream['r_frame_rate']
        numerator, denominator = rate.split('/')
        fps = int(numerator) / int(denominator)
        times = sorted(float(packet['pts_time']) for packet in data['packets'])
        return {'width': int(stream['width']), 'height': int(stream['height']), 'frames': len(times), 'fps': fps,
                'offset': max(abs(time * fps - n) for n, time in enumerate(times))}
    except (OSError, subprocess.CalledProcessError, ValueError, KeyError, IndexError, ZeroDivisionError) as error:
        raise SystemExit(f"{path}: ffprobe could not read the video's size, frames and rate ({error}).")


def size(path):
    """A frame's width and height in pixels: a PNG, WebP or GIF's from its header, a video's from
    ffprobe."""
    if is_video(path.name):
        video = clip(path)
        return video['width'], video['height']
    with path.open('rb') as file:
        head = file.read(30)
    if head[:8] == b'\x89PNG\r\n\x1a\n':
        return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')
    if head[:4] == b'GIF8':
        return int.from_bytes(head[6:8], 'little'), int.from_bytes(head[8:10], 'little')
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        if head[12:16] == b'VP8X':
            return int.from_bytes(head[24:27], 'little') + 1, int.from_bytes(head[27:30], 'little') + 1
        if head[12:16] == b'VP8L':
            bits = int.from_bytes(head[21:25], 'little')
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if head[12:16] == b'VP8 ':
            return int.from_bytes(head[26:28], 'little') & 0x3FFF, int.from_bytes(head[28:30], 'little') & 0x3FFF
    raise SystemExit(f"{path}: not a PNG, WebP, GIF, MP4 or WebM.")


def build(manifest_path, output_path, linked=False):
    manifest_path = pathlib.Path(manifest_path).absolute()
    root = manifest_path.parent
    output = pathlib.Path(output_path).absolute()
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    check(manifest, root)

    def address(file):
        return urllib.parse.quote(pathlib.Path(os.path.relpath(root / file, output.parent)).as_posix())

    store = {}
    # A file several frames reuse keeps the first base any of them names.
    bases = {}
    for f in manifest['frames']:
        bases[f['file']] = bases.get(f['file']) or f.get('base')
    for f in manifest['frames']:
        if f['file'] in store:
            continue
        if linked:
            store[f['file']] = address(f['file'])
        elif bases[f['file']]:
            store[f['file']] = tiled(root, f['file'], bases[f['file']])
        else:
            store[f['file']] = base64.b64encode((root / f['file']).read_bytes()).decode('ascii')
    # A chain of bases must end on a stored image, not loop.
    for file in store:
        seen = set()
        while isinstance(store[file], dict):
            if file in seen:
                raise SystemExit(f"{file}: its bases loop.")
            seen.add(file)
            file = store[file]['base']

    e = html.escape
    parts = [
        '<!doctype html><html lang="en"><head><meta charset="utf-8">',
        f"<title>{e(manifest['title'])}</title>", STYLE, '</head><body>',
        f"<h1>{e(manifest['title'])}</h1>",
    ]
    intro = manifest.get('intro') or []
    for paragraph in [intro] if isinstance(intro, str) else intro:
        parts.append(f"<p>{e(paragraph)}</p>")

    def tables(items):
        for table in items or []:
            parts.append(f"<p class=\"note\">{e(table['caption'])}</p><table>")
            parts.append('<tr>' + ''.join(f"<th>{e(str(c))}</th>" for c in table['header']) + '</tr>')
            for row in table['rows']:
                parts.append('<tr>' + ''.join(f"<td>{e(str(c))}</td>" for c in row) + '</tr>')
            parts.append('</table>')

    def references(items):
        for r in items or []:
            if linked:
                source = address(r['file'])
            else:
                data = base64.b64encode((root / r['file']).read_bytes()).decode('ascii')
                source = f"data:image/{r['file'].split('.')[-1]};base64,{data}"
            parts.append(
                f"<div class=\"stage\"><img alt=\"\" src=\"{e(source)}\"></div>"
                f"<div class=\"caption\">{e(r['caption'])}</div>")

    def buttons(decision, options):
        return ''.join(
            f"<button data-decision=\"{e(decision['id'])}\" data-option=\"{e(o['id'])}\" title=\"{e(o.get('tooltip', ''))}\" data-tooltip=\"{e(o.get('tooltip', ''))}\">{e(o['name'])}</button>"
            for o in options)

    def option_rows(decision, label):
        if not decision['options'][0].get('group'):
            parts.append('<div class="row">' + label + buttons(decision, decision['options']) + '</div>')
            return
        if label:
            parts.append('<div class="row">' + label + '</div>')
        for group in dict.fromkeys(o['group'] for o in decision['options']):
            parts.append(f"<div class=\"row group\"><span class=\"label\">{e(group)}</span>"
                         + buttons(decision, [o for o in decision['options'] if o['group'] == group]) + '</div>')

    tables(manifest.get('tables'))
    references(manifest.get('references'))
    parts.append(
        '<div class="picks"><span>Picks</span><code id="picks-text"></code>'
        '<button id="picks-copy">Copy</button></div>')
    for d in manifest['decisions']:
        recommended = manifest['preselected'][d['id']]
        parts.append(f"<h2>{e(d['name'])}</h2>")
        if d.get('note'):
            parts.append(f"<p class=\"note\">{e(d['note'])}</p>")
        tables(d.get('tables'))
        references(d.get('references'))
        parts.append('<table><tr><th>Option</th>' + ''.join(f'<th>{e(h)}</th>' for h in PRICING.values()) + '</tr>')
        group = None
        for o in d['options']:
            if o.get('group') != group:
                group = o['group']
                parts.append(f"<tr><th colspan=\"{len(PRICING) + 1}\">{e(group)}</th></tr>")
            row = manifest['pricing'][d['id']][o['id']]
            mark = ' class="recommended"' if o['id'] == recommended else ''
            parts.append(f"<tr{mark}><td>{e(o['name'])}</td>" + ''.join(f'<td>{e(row[key])}</td>' for key in PRICING) + '</tr>')
        parts.append('</table>')
        if d.get('stage'):
            continue
        if not d.get('shots'):
            parts.append('<div class="unstaged">')
            option_rows(d, '')
            parts.append('</div>')
            continue
        parts.append(f"<div id=\"stage-{e(d['id'])}\" class=\"host\">")
        rows = [g for g in manifest['decisions'] if g.get('stage') == d['id']]
        for row in rows + [d]:
            option_rows(row, f"<span class=\"label\">{e(row['name'])}</span>" if rows else '')
        # The unzoomed stage holds its largest frame's size as drawn at the page's width, so the shot
        # buttons under it stay put as shots swap.
        shot_by_id = {s['id']: s for s in d['shots']}
        sizes = sorted({drawn_size(shot_by_id[f['shot']], size(root / f['file']))
                        for f in manifest['frames'] if f['decision'] == d['id']})
        heights = ', '.join(f'min({h}px, calc(100cqw * {h} / {w}))' for w, h in sizes)
        hold = f" style=\"--hold-w: {max(w for w, _ in sizes)}px; --hold-h: max({heights})\"" if sizes else ''
        parts.append(f'<div class="stage"{hold}><img alt=""><canvas style="display:none"></canvas></div>')
        if any(is_video(f['file']) for f in manifest['frames'] if f['decision'] == d['id']):
            parts.append(
                '<div class="frame-controls"><button data-clip-step="-1" title="Left arrow">Previous frame</button>'
                '<button data-clip-play>Play</button><button data-clip-step="1" title="Right arrow">Next frame</button>'
                '<input type="range" min="0" step="1" value="0" aria-label="Frame"><output></output></div>')
        parts.append('<div class="caption"></div>')
        parts.append('<div class="row">' + ''.join(
            f"<button data-decision=\"{e(d['id'])}\" data-shot=\"{e(s['id'])}\">{e(s['name'])}</button>"
            for s in d['shots']) + '</div>')
        if d.get('sliders'):
            parts.append('<div class="sliders">')
            for s in d['sliders']:
                parts.append(
                    f"<label data-slider-row=\"{e(s['id'])}\">{e(s['name'])}</label>"
                    f"<input data-slider-row=\"{e(s['id'])}\" type=\"range\" min=\"0\" max=\"{len(s['stops']) - 1}\" step=\"1\" "
                    f"data-decision=\"{e(d['id'])}\" data-slider=\"{e(s['id'])}\">"
                    f"<output data-slider-row=\"{e(s['id'])}\" data-slider=\"{e(s['id'])}\"></output>"
                    f"<button data-slider-row=\"{e(s['id'])}\" data-decision=\"{e(d['id'])}\" data-play=\"{e(s['id'])}\">Play</button>")
            parts.append('</div>')
        parts.append('</div>')

    gate = {key: manifest[key] for key in ('decisions', 'preselected', 'frames')}
    gate['cropGap'] = CROP_GAP
    gate['zoomClick'] = CLICK_ZOOM
    gate['zoomMax'] = ZOOM_MAX
    gate['linked'] = linked
    gate['videoTypes'] = VIDEO_TYPES
    gate['clips'] = {f['file']: {key: clip(root / f['file'])[key] for key in ('frames', 'fps')}
                     for f in manifest['frames'] if is_video(f['file'])}
    parts.append(f'<script id="frame-store" type="application/json">{json.dumps(store)}</script>')
    parts.append(
        '<script id="gate" type="application/json">'
        + json.dumps(gate).replace('</', '<\\/') + '</script>')
    parts.append(SCRIPT)
    parts.append('</body></html>')
    output.write_text('\n'.join(parts), encoding='utf-8', newline='\n')
    print(f"{output}: {len(manifest['decisions'])} decisions, {len(store)} frames, "
          f"{output.stat().st_size / 1e6:.1f} MB")


if __name__ == '__main__':
    arguments = [a for a in sys.argv[1:] if a != '--linked']
    if len(arguments) != 2:
        raise SystemExit(__doc__)
    build(*arguments, linked='--linked' in sys.argv[1:])
