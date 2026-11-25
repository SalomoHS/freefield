// The Editing Room. One project = one clip on a timeline (server/editroom.ts keeps it in out/editroom/):
//   #/edit            the last project (or an empty room to upload into)
//   #/edit/<id>       a project: FINAL over INPUT, the timeline, edits as blocks over the part they change
//   #/edit/videos     My videos: the projects, and every edit made in them
// "Cut here" splits the clip into parts; "+" over a part (or an edit from the left) changes only that part. The server
// cuts that part from the final video as it stands, runs the edit (an ordinary History run), and lays the result back
// over its part; the newest edit is on top. The final video is re-rendered whenever an edit finishes.
import { el, icon, toast, store, clamp, popover, closePopover, api } from "./util.js";
import { byId } from "./catalog.js";
import { feed, isDone, statusText, deleteButton } from "./feed.js";
import { ago } from "./i18n.js";

const OR_APP = "openrouter-video-edit";
const OR = {
  // perSecond, minimum, perReference (USD) and durations: OpenRouter's listing in November 2026, for the estimate only
  flux: { model: "black-forest-labs/flux-video-edit", name: "FLUX Video Edit", price: "$0.03/s", perSecond: 0.03 },
  seed: { model: "bytedance/seedance-2.5", name: "Seedance 2.5", price: "per token", audio: true },
  hailuo: { model: "minimax/hailuo-3", name: "Hailuo 3", price: "$0.13/s", perSecond: 0.13, perReference: 0.04, audio: true,
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] },
  aleph: { model: "runway/aleph-2", name: "Runway Aleph 2", price: "$0.28/s, min $0.56", perSecond: 0.28, minimum: 0.56 },
  upscale: { app: "openrouter-video-upscale", model: "black-forest-labs/flux-video-upscale", name: "FLUX Video Upscale", price: "$0.035 per megapixel-second" },
};
// FLUX Video Upscale's rates (USD per megapixel-second of the result), for the estimate on the button
const UPSCALE_RATE = { precise: 0.035, creative: 0.05 };
// local apps: which of their inputs get the reference image and the prompt (the server fills the clip)
const LOCAL = {
  recast: { ref: "character", prompt: "prompt" },
  reshoot: { prompt: "prompt" },
  "vfx-day-to-night": { prompt: "prompt" },
  "upscale-video": {},
};

const OPS = [
  { id: "swap", icon: "user", title: "Swap person", sub: "Put someone else in the shot", ref: "required", refLabel: "The new person",
    engines: ["or:seed", "or:hailuo", "or:flux", "local:recast"], presets: [],
    template: () => "Replace the main person in the video with the person in the reference image. Keep the same motion, pose, framing, camera and lighting." },
  { id: "angle", icon: "camera", title: "Change angle", sub: "Re-shoot from a new angle",
    engines: ["or:aleph", "or:seed", "local:reshoot"],
    presets: ["Low angle", "High angle", "Side profile", "Close-up", "Wide shot", "Over the shoulder"],
    template: (p) => `Show this exact scene from a ${p.toLowerCase()} camera angle: the same moment, the same people and action, the same lighting.` },
  { id: "location", icon: "globe", title: "Change location", sub: "Move the shot to a new place", ref: "optional", refLabel: "The place (optional)",
    engines: ["or:flux", "or:aleph", "or:seed"],
    presets: ["Snowy mountain village", "Neon Tokyo street at night", "Tropical beach at sunset", "Desert canyon", "Modern glass office", "Rainy Jakarta street"],
    template: (p) => `Move the scene to a ${p.toLowerCase()}. Keep the people, their clothes, their motion and the camera framing unchanged.` },
  { id: "camera", icon: "video", title: "Move camera", sub: "Re-film with a moving camera",
    engines: ["or:aleph", "or:seed"],
    presets: ["Slow dolly in", "Dolly out", "Orbit left", "Orbit right", "Crane up", "Handheld"],
    template: (p) => `Re-film this scene with a smooth ${p.toLowerCase()} camera move. Keep the people, the action and the lighting the same.` },
  { id: "relight", icon: "sun", title: "Relight", sub: "Change the lighting of the shot",
    engines: ["or:flux", "or:aleph", "local:vfx-day-to-night"],
    presets: ["Golden hour", "Blue hour", "Night with neon signs", "Soft overcast", "Studio key light", "Candlelight"],
    template: (p) => `Relight the scene with ${p.toLowerCase()} lighting. Keep the people, their motion, the place and the framing unchanged.` },
  { id: "prompt", icon: "wand", title: "Edit with prompt", sub: "Say what to change", ref: "optional", refLabel: "Reference image (optional)",
    engines: ["or:flux", "or:aleph", "or:seed", "or:hailuo"], presets: [], template: () => "" },
  { id: "upscale", icon: "expand", title: "Upscale", sub: "Make it bigger and sharper", upscale: true,
    engines: ["or:upscale", "local:upscale-video"], presets: [], template: () => "" },
];
const opById = new Map(OPS.map((o) => [o.id, o]));

function engineInfo(key) {
  const [kind, id] = key.split(":");
  if (kind === "or") {
    const app = byId.get(OR[id].app || OR_APP);
    return { key, name: OR[id].name, note: `OpenRouter · ${OR[id].price}`, app, ok: Boolean(app?.runnable), why: app ? null : `the ${OR[id].app || OR_APP} app is missing` };
  }
  const app = byId.get(id);
  const blocked = !app || !app.runnable || app.missing_pack || app.needs;
  return { key, name: app ? `${app.name} (local)` : id, note: "Your GPU · free", app, ok: !blocked, why: !app ? "not in this studio" : blocked ? "its models are not downloaded yet" : null };
}

// ------------------------------------------------------------------ small helpers
const mmss = (s) => { s = Math.max(0, s || 0); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`; };
const secs = (s) => `${(Math.round(s * 10) / 10).toFixed(1)} s`;
const fmtRange = (a, b) => `${mmss(a)}.${Math.floor((a % 1) * 10)}–${mmss(b)}.${Math.floor((b % 1) * 10)}`;
const LAST = "editroom.last";

/** The parts the cuts make: [[0, c1], [c1, c2], ..., [cn, duration]]. */
const partsOf = (p) => { const m = [0, ...p.cuts, p.source.duration]; return m.slice(0, -1).map((a, i) => [a, m[i + 1]]); };
const partAt = (p, t) => partsOf(p).find(([a, b]) => t >= a && t < b) || partsOf(p).at(-1);

/** Which row each edit sits on: one above the highest earlier edit it overlaps. */
function levels(edits) {
  const sorted = [...edits].sort((a, b) => (a.created < b.created ? -1 : 1));
  const lv = new Map();
  for (const e of sorted) {
    let l = 1;
    for (const o of sorted) {
      if (o === e) break;
      if (o.start < e.end && e.start < o.end) l = Math.max(l, lv.get(o.id) + 1);
    }
    lv.set(e.id, l);
  }
  return lv;
}

// ------------------------------------------------------------------ filmstrips (frames drawn from the videos themselves)
const grabbers = new Map();   // url → { video, chain }
const frames = new Map();     // `${url}@${t}` → canvas
function frameAt(url, t, h) {
  const key = `${url}@${t.toFixed(2)}@${h}`;
  if (frames.has(key)) return Promise.resolve(frames.get(key));
  let g = grabbers.get(url);
  if (!g) {
    const video = el("video", { src: url, muted: true, preload: "auto", playsinline: true, crossorigin: "anonymous" });
    video.muted = true;
    g = { video, chain: new Promise((ok) => { video.addEventListener("loadeddata", ok, { once: true }); video.addEventListener("error", ok, { once: true }); }) };
    grabbers.set(url, g);
  }
  const job = g.chain.then(() => new Promise((ok) => {
    const v = g.video;
    if (!v.videoWidth) return ok(null);
    const done = () => {
      const c = document.createElement("canvas");
      c.height = h;
      c.width = Math.round((h * v.videoWidth) / v.videoHeight);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      frames.set(key, c);
      ok(c);
    };
    const target = clamp(t, 0, Math.max(0, (v.duration || 0) - 0.05));
    if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) return done();
    v.addEventListener("seeked", done, { once: true });
    v.currentTime = target;
  }));
  g.chain = job.catch(() => {});
  return job;
}

/** A strip of frames from url covering [from, from + length) of it, width × h px. */
function filmstrip(url, from, length, width, h, aspect) {
  const c = el("canvas", { class: "er-strip" });
  c.width = Math.max(1, Math.round(width));
  c.height = h;
  const tile = Math.max(24, Math.round(h * aspect));
  const n = Math.min(60, Math.max(1, Math.ceil(width / tile)));
  const ctx = c.getContext("2d");
  for (let i = 0; i < n; i++) {
    const t = from + ((i + 0.5) / n) * length;
    frameAt(url, t, h).then((f) => { if (f && c.isConnected !== false) ctx.drawImage(f, i * tile, 0, tile, h); });
  }
  return c;
}

// ------------------------------------------------------------------ the shared top of both views
function roomTabs(active, projectId) {
  return el("nav", { class: "er-tabs", "aria-label": "Editing Room" },
    el("a", { href: projectId ? `#/edit/${projectId}` : "#/edit", "aria-current": active === "edit" ? "page" : null }, icon("wand"), "Edit"),
    el("a", { href: "#/edit/videos", "aria-current": active === "videos" ? "page" : null }, icon("film"), "My videos"));
}

export function editRoomView() {
  const arg = /^#\/edit\/([\w-]+)/.exec(location.hash)?.[1];
  if (arg === "videos") return myVideosView();
  if (arg === "new") return editorView(null);
  return editorView(arg || store.get(LAST, null));
}

// ------------------------------------------------------------------ the editor
function editorView(projectId) {
  let project = null;
  let finalUrl = null;          // the render with every finished edit (source.mp4 until one has)
  let rendering = false;
  let renderedFor = "";         // which finished edits the final video has
  let range = null;             // [start, end] the next edit changes
  let op = null;                // the operation whose form is open
  let selected = null;          // an edit block picked on the timeline
  let zoom = store.get("editroom.zoom", 1);
  let disposed = false;
  let loading = Boolean(projectId);

  const left = el("aside", { class: "er-side" });
  const countBtn = el("button", { class: "btn ghost small er-count", type: "button" });
  const exportBtn = el("a", { class: "btn white small", download: "" }, icon("download"), "Export");
  const preview = el("div", { class: "er-preview" });
  const timeline = el("div", { class: "er-timeline" });
  const transport = el("div", { class: "er-transport" });
  const main = el("section", { class: "er-main" },
    el("div", { class: "er-bar" }, roomTabs("edit", projectId), el("div", { class: "row" }, countBtn, exportBtn)),
    preview, timeline, transport);
  const node = el("div", { class: "er" }, left, main);

  // ---- the two videos: FINAL drives, INPUT follows
  const vFinal = el("video", { playsinline: true, preload: "auto", muted: true });
  const vInput = el("video", { playsinline: true, preload: "auto", muted: true });
  vFinal.muted = true;
  vInput.muted = true;
  let muted = true;
  const follow = () => { if (vInput.src && Math.abs(vInput.currentTime - vFinal.currentTime) > 0.12) vInput.currentTime = vFinal.currentTime; };
  vFinal.addEventListener("play", () => { follow(); vInput.play().catch(() => {}); drawTransport(); tick(); });
  vFinal.addEventListener("pause", () => { vInput.pause(); follow(); drawTransport(); });
  vFinal.addEventListener("seeked", () => { follow(); movePlayhead(); });
  vFinal.addEventListener("ended", () => { vInput.pause(); drawTransport(); });
  const now = () => vFinal.currentTime || 0;
  function seek(t) {
    if (!project) return;
    const to = clamp(t, 0, project.source.duration - 0.01);
    vFinal.currentTime = to;
    vInput.currentTime = to;
    movePlayhead();
  }
  function tick() {
    movePlayhead();
    if (!vFinal.paused && !disposed) requestAnimationFrame(tick);
  }

  // ---------------- load and render
  async function load(id) {
    try {
      project = await api(`/api/editroom/${id}`);
      loading = false;
      store.set(LAST, project.id);
      if (location.hash !== `#/edit/${project.id}`) history.replaceState(null, "", `#/edit/${project.id}`);
      vInput.src = project.source_url;
      finalUrl = project.source_url;
      vFinal.src = finalUrl;
      drawAll();
      render();
    } catch (err) {
      loading = false;
      if (err.status === 404 || err.status === 400) { store.set(LAST, null); project = null; drawAll(); return; }
      toast(err.message, { error: true });
      drawAll();
    }
  }

  const finishedKey = () => (project?.edits || []).filter((e) => feed.get(e.entry)?.status === "succeeded").map((e) => e.id).join(",");
  async function render() {
    if (!project || rendering) return;
    const key = finishedKey();
    if (key === renderedFor) return;
    rendering = true;
    drawPreview();
    try {
      const r = await api(`/api/editroom/${project.id}/render`, { method: "POST" });
      renderedFor = key;
      if (r.url !== finalUrl) {
        const playing = !vFinal.paused;
        finalUrl = r.url;
        vFinal.src = finalUrl;
        // INPUT keeps its place while FINAL loads the new render: pick up from there (the playhead may have moved meanwhile)
        vFinal.addEventListener("loadedmetadata", () => { vFinal.currentTime = vInput.currentTime; movePlayhead(); if (playing) vFinal.play().catch(() => {}); }, { once: true });
      }
    } catch (err) {
      toast(`Could not render the final video: ${err.message}`, { error: true });
    } finally {
      rendering = false;
      drawPreview();
      drawHeader();
      if (finishedKey() !== renderedFor) render();
    }
  }

  // ---------------- left: the clip, then the operations or one operation's form
  const fileInput = el("input", { type: "file", accept: "video/*", hidden: true, onchange: () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) createFrom({ clip: f });
  } });

  async function createFrom({ clip = null, from = null, name = "" }) {
    if (clip && clip.size > 100 * 1024 * 1024) return toast("That clip is over 100 MB: trim it first.", { error: true });
    const fd = new FormData();
    if (clip) fd.append("clip", clip, clip.name);
    if (from) { fd.append("from", from); fd.append("name", name); }
    left.querySelector(".er-upload")?.classList.add("busy");
    try {
      const p = await api("/api/editroom", { method: "POST", body: fd });
      location.hash = `#/edit/${p.id}`;
    } catch (err) {
      toast(err.message, { error: true });
      left.querySelector(".er-upload")?.classList.remove("busy");
    }
  }

  function libraryPicker(anchor) {
    const vids = feed.list().filter((e) => e.status === "succeeded" && e.outputs.some((o) => o.type === "video")).slice(0, 18);
    if (!vids.length) return toast("No videos in your Library yet.");
    popover(anchor, el("div", {}, el("h4", {}, "From your Library"), el("div", { class: "er-lib" }, ...vids.map((e) => {
      const url = e.outputs.find((o) => o.type === "video").url;
      const name = byId.get(e.app)?.name || e.app;
      return el("button", { type: "button", class: "er-lib-item", title: name, onclick: () => { closePopover(); createFrom({ from: url, name: `${name} ${e.id.slice(9, 15)}` }); } },
        el("video", { src: `${url}#t=0.1`, muted: true, preload: "metadata", playsinline: true }), el("span", {}, name));
    }))), { width: 360 });
  }

  function uploadCard() {
    const card = el("div", { class: `er-upload${project ? " has" : ""}`, role: "button", tabindex: "0", onclick: () => fileInput.click(),
      onkeydown: (e) => { if (e.key === "Enter") fileInput.click(); } },
      el("span", { class: "ic" }, icon(project ? "swap" : "upload")),
      el("b", {}, project ? project.name : "Upload video to edit"),
      el("small", {}, project ? `${secs(project.source.duration)} · ${project.source.width}×${project.source.height} · click for a new clip` : "MP4 or MOV, up to 100 MB · 3–15 s works best"));
    card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag"); });
    card.addEventListener("dragleave", () => card.classList.remove("drag"));
    card.addEventListener("drop", (e) => {
      e.preventDefault();
      card.classList.remove("drag");
      const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith("video/"));
      if (f) createFrom({ clip: f });
    });
    const lib = el("button", { class: "btn ghost small er-fromlib", type: "button" }, icon("film"), "Pick from Library");
    lib.onclick = () => libraryPicker(lib);
    return el("div", {}, card, lib, fileInput);
  }

  function opList() {
    const head = project ? el("div", { class: "er-part-head" },
      el("span", {}, range ? `Edit the part ${fmtRange(...range)}` : "Edit the whole clip"),
      range ? el("button", { class: "mini-link", type: "button", onclick: () => { range = null; drawLeft(); drawTimeline(); } }, "Whole clip") : null) : null;
    return el("div", { class: "er-ops" }, head, ...OPS.map((o) => el("button", { class: "er-op", type: "button", disabled: !project,
      onclick: () => { op = o; if (!range) range = [0, project.source.duration]; drawLeft(); drawTimeline(); } },
      el("span", { class: "ic" }, icon(o.icon)),
      el("span", { class: "tx" }, el("b", {}, o.title), el("small", {}, o.sub)),
      icon("chevR"))));
  }

  // One edit's settings as cards: references, the prompt (with quick picks and sound), the model, the settings, and
  // Generate with what it should cost. Pickers open as popovers, so the form stays short.
  function opForm(o) {
    const engines = o.engines.map(engineInfo);
    let chosen = (engines.find((e) => e.ok) || engines[0]).key;
    let quality = "720p";
    let factor = 2;
    let creativity = 0;
    let sound = false;
    let refFile = null;
    const orId = () => (chosen.startsWith("or:") ? chosen.slice(3) : null);
    const [start, end] = range;
    const len = end - start;

    function pickCard(label, options, current, onPick, cls = "") {
      const value = el("b");
      const sub = el("small");
      const card = el("button", { class: `er-card er-pick ${cls}`.trim(), type: "button" },
        el("span", { class: "tx" }, el("span", { class: "lb" }, label), value, sub), icon("chevR"));
      const show = (v) => {
        const opt = options().find((x) => x.value === v) || options()[0];
        value.textContent = opt.label;
        sub.textContent = opt.short || "";
        sub.hidden = !opt.short;
      };
      card.onclick = () => popover(card, el("div", {}, el("h4", {}, label), ...options().map((x) => el("button", {
        class: "opt", type: "button", "aria-selected": String(x.value === current()), disabled: x.disabled || null, title: x.why || null,
        onclick: () => { closePopover(); onPick(x.value); show(x.value); refresh(); },
      }, el("span", { class: "two" }, el("span", {}, x.label), x.note ? el("small", {}, x.note) : null), el("span", { class: "chk" }, icon("check"))))),
      { width: 300 });
      show(current());
      return card;
    }

    const refInput = el("input", { type: "file", accept: "image/*", hidden: true, onchange: () => {
      refFile = refInput.files?.[0] || null;
      refInput.value = "";
      drawRef();
      refresh();
    } });
    const refBox = el("div", { class: "er-card er-refs", role: "button", tabindex: "0", onclick: (e) => { if (e.target !== refInput && !e.target.closest(".er-x2")) refInput.click(); },
      onkeydown: (e) => { if (e.key === "Enter") refInput.click(); } });
    function drawRef() {
      if (refFile) {
        refBox.classList.add("has");
        refBox.replaceChildren(el("img", { src: URL.createObjectURL(refFile), alt: "" }),
          el("span", { class: "tx" }, el("b", {}, o.refLabel), el("small", {}, refFile.name)),
          el("button", { class: "mini er-x2", type: "button", "aria-label": "Remove the image", onclick: () => { refFile = null; drawRef(); refresh(); } }, icon("x")));
      } else {
        refBox.classList.remove("has");
        refBox.replaceChildren(el("span", { class: "er-refs-ic" }, icon(o.id === "swap" ? "user" : "image")),
          el("b", {}, o.ref === "required" ? `Add ${o.refLabel.toLowerCase()}` : "Add a reference"),
          el("small", {}, o.ref === "required" ? "A clear photo, face visible" : `${o.refLabel} · image`));
      }
      refBox.append(refInput);
    }
    if (o.ref) drawRef();

    const prompt = el("textarea", { class: "er-ta", rows: "4",
      placeholder: o.upscale ? "Optional: what the detail should look like, e.g. sharp skin texture, fine film grain"
        : "Describe the change, e.g. \"make it snow\" or \"make it night\", and what must stay the same",
      value: o.template(o.presets[0] || "") });
    const presetChips = o.presets.map((p, i) => el("button", { class: "er-tool", type: "button", "aria-pressed": String(i === 0), onclick: (ev) => {
      for (const b of ev.currentTarget.parentNode.querySelectorAll("[data-preset]")) b.setAttribute("aria-pressed", String(b === ev.currentTarget));
      prompt.value = o.template(p);
    }, dataset: { preset: p } }, p));
    const soundChip = el("button", { class: "er-tool", type: "button", "aria-pressed": "false", onclick: () => { sound = !sound; refresh(); } });
    const promptCard = el("div", { class: "er-card er-prompt" },
      el("span", { class: "lb" }, o.upscale ? "Guide (optional)" : "Prompt"), prompt, el("div", { class: "er-tools" }, ...presetChips, soundChip));

    const modelCard = pickCard("Model", () => engines.map((e) => ({
      value: e.key, label: e.name, short: e.ok ? e.note : e.why, note: e.ok ? e.note : e.why, disabled: !e.ok, why: e.why,
    })), () => chosen, (v) => { chosen = v; }, "er-model");
    const partCard = el("div", { class: "er-card er-pick static" }, el("span", { class: "tx" }, el("span", { class: "lb" }, "Part"),
      el("b", {}, fmtRange(start, end)), el("small", {}, `${secs(len)} of ${secs(project.source.duration)}`)));
    const settings = o.upscale ? [
      pickCard("Enlarge", () => [1.5, 2, 3].map((f) => ({ value: f, label: `${f}×` })), () => factor, (v) => { factor = v; }),
      pickCard("Detail", () => [
        { value: 0, label: "Precise", note: "Sharpens what is there" },
        { value: 0.5, label: "Creative", note: "Adds finer detail, costs more" },
      ], () => creativity, (v) => { creativity = v; }),
      partCard,
    ] : [
      pickCard("Quality", () => ["480p", "720p", "1080p"].map((r) => ({ value: r, label: r })), () => quality, (v) => { quality = v; }),
      partCard,
    ];

    function cost() {
      const id = orId();
      if (!id) return { text: "", note: "Free: runs on your GPU" };
      if (o.upscale) {
        const { width: w, height: h } = project.source;
        const usd = ((w * factor * h * factor) / 1e6) * len * (creativity > 0 ? UPSCALE_RATE.creative : UPSCALE_RATE.precise);
        return { text: `~$${usd.toFixed(2)}`, note: `${Math.round(w * factor)}×${Math.round(h * factor)} · ${secs(len)}` };
      }
      const rate = OR[id].perSecond;
      if (!rate) return { text: "", note: `${OR[id].name} is billed ${OR[id].price}` };
      const s = OR[id].durations ? OR[id].durations.reduce((b, n) => (Math.abs(n - len) < Math.abs(b - len) ? n : b)) : len;
      const usd = Math.max(OR[id].minimum || 0, rate * s) + (refFile && OR[id].perReference ? OR[id].perReference : 0);
      return { text: `~$${usd.toFixed(2)}`, note: `${secs(s)} at ${OR[id].price}` };
    }

    const goLabel = el("span");
    const goCost = el("span", { class: "er-cost" });
    const go = el("button", { class: "er-generate", type: "button" }, goLabel, goCost);
    const costNote = el("p", { class: "er-costnote" });
    function refresh() {
      const id = orId();
      const hasSound = Boolean(id && OR[id].audio);
      soundChip.hidden = !hasSound || o.upscale;
      if (!hasSound) sound = false;
      soundChip.setAttribute("aria-pressed", String(sound));
      soundChip.replaceChildren(icon(sound ? "volume" : "mute"), sound ? "Sound on" : "Sound off");
      goLabel.replaceChildren("Generate");
      const c = cost();
      goCost.replaceChildren(...(c.text ? [icon("spark"), c.text] : []));
      costNote.textContent = c.note;
    }

    go.onclick = async () => {
      const text = prompt.value.trim();
      if (!text && !o.upscale) return toast("Write what to change first.", { error: true });
      if (o.ref === "required" && !refFile) return toast(`Add ${o.refLabel.toLowerCase()} first.`, { error: true });
      go.disabled = true;
      goLabel.replaceChildren("Cutting the part…");
      try {
        await apply(o, chosen, text, refFile, { quality, factor, creativity, sound, start, end });
        op = null;
        range = null;
        drawAll();
      } catch (err) {
        toast(err.message, { error: true });
        go.disabled = false;
        refresh();
      }
    };
    refresh();

    return el("div", { class: "er-form" },
      el("div", { class: "er-form-top" },
        el("button", { class: "er-back", type: "button", "aria-label": "All edits", onclick: () => { op = null; drawLeft(); } }, icon("chevL")),
        el("span", { class: "ic" }, icon(o.icon)),
        el("div", {}, el("b", {}, o.title), el("small", {}, o.sub))),
      o.ref ? refBox : null,
      promptCard,
      modelCard,
      el("div", { class: "er-grid" }, ...settings),
      go,
      costNote);
  }

  async function apply(o, engineKey, text, refFile, { quality, factor, creativity, sound, start, end }) {
    const fd = new FormData();
    const [kind, id] = engineKey.split(":");
    let appId;
    let title = o.title;
    if (kind === "or" && o.upscale) {
      appId = OR[id].app;
      fd.append("model", OR[id].model);
      fd.append("factor", String(factor));
      fd.append("creativity", String(creativity));
      if (text) fd.append("prompt", text);
      title = `Upscale ${factor}×`;
    } else if (kind === "or") {
      appId = OR_APP;
      if (refFile) fd.append("reference", refFile, refFile.name);
      fd.append("prompt", text);
      fd.append("model", OR[id].model);
      fd.append("duration", String(clamp(Math.round(end - start), 3, 15)));
      fd.append("resolution", quality);
      fd.append("audio", sound ? "true" : "false");
    } else {
      appId = id;
      const map = LOCAL[id];
      if (map.ref && refFile) fd.append(map.ref, refFile, refFile.name);
      if (map.prompt) fd.append(map.prompt, text);
    }
    fd.append("app", appId);
    fd.append("op", o.id);
    fd.append("title", title);
    fd.append("engine", engineKey);
    fd.append("start", String(start));
    fd.append("end", String(end));
    const r = await api(`/api/editroom/${project.id}/edits`, { method: "POST", body: fd });
    project = r.project;
    feed.entries.set(r.entry.id, r.entry);
    feed.emit();
    feed.schedule();
    selected = project.edits.at(-1)?.id || null;
  }

  function drawLeft() {
    left.replaceChildren(uploadCard(), op && project ? opForm(op) : opList());
  }

  // ---------------- header
  function drawHeader() {
    const n = project?.edits.length || 0;
    countBtn.replaceChildren(icon("clock"), `${n} ${n === 1 ? "edit" : "edits"}`, icon("chevD"));
    countBtn.disabled = !n;
    countBtn.onclick = () => popover(countBtn, el("div", {}, el("h4", {}, "Edits, newest first"), ...[...project.edits].reverse().map((e) => {
      const entry = feed.get(e.entry);
      return el("button", { class: "opt", type: "button", "aria-selected": String(e.id === selected), onclick: () => { closePopover(); selected = e.id; seek(e.start); drawTimeline(); } },
        el("span", { class: "two" }, el("span", {}, `${e.title} · ${fmtRange(e.start, e.end)}`), el("small", {}, `${engineInfo(e.engine).name} · ${entry ? (isDone(entry) ? entry.status : statusText(entry)) : "…"}`)),
        el("span", { class: "chk" }, icon("check")));
    })), { align: "end", width: 340 });
    exportBtn.hidden = !project;
    exportBtn.href = finalUrl || "#";
    exportBtn.download = `${project?.name || "video"}-final.mp4`;
  }

  // ---------------- preview: INPUT and FINAL, three ways to look (Split, Compare with a wipe line, Final alone)
  let viewMode = store.get("editroom.view", "split");
  let wipe = 50;
  function drawPreview() {
    if (!project && loading) { preview.replaceChildren(el("div", { class: "er-empty" }, el("b", {}, "Loading…"))); return; }
    if (!project) {
      preview.replaceChildren(el("div", { class: "er-empty" }, icon("film"), el("b", {}, "Start with a clip"),
        el("p", {}, "Upload a video (or pick one you made). Cut it into parts, then change any part: swap a person, the place, the light, the angle."),
        el("div", { class: "row" }, el("button", { class: "btn lime", type: "button", onclick: () => fileInput.click() }, icon("upload"), "Upload video"))));
      return;
    }
    let stage = preview.querySelector(".er-stage2");
    if (!stage) {
      const modes = el("div", { class: "er-modes", role: "group", "aria-label": "View" }, ...[["split", "rows", "Split"], ["compare", "compare", "Compare"], ["final", "video", "Final"]]
        .map(([id, ic, label]) => el("button", { type: "button", dataset: { mode: id }, onclick: () => { viewMode = id; store.set("editroom.view", id); drawPreview(); } }, icon(ic), label)));
      stage = el("div", { class: "er-stage2" },
        el("div", { class: "er-pane input" }, vInput, el("span", { class: "er-label" }, "INPUT")),
        el("div", { class: "er-pane final" }, vFinal, el("span", { class: "er-label lime" }, "FINAL"), el("span", { class: "er-rendering" }, icon("clock"), "Rendering…")),
        el("div", { class: "er-wipe" }, el("span", {}, icon("chevL"), icon("chevR"))));
      // Compare: drag anywhere on the picture to move the line between INPUT (left) and FINAL (right)
      stage.addEventListener("pointerdown", (ev) => {
        if (viewMode !== "compare" || ev.target.closest(".er-modes")) return;
        const at = (x) => {
          const r = stage.getBoundingClientRect();
          wipe = clamp(((x - r.left) / r.width) * 100, 0, 100);
          stage.style.setProperty("--wipe", `${wipe}%`);
        };
        at(ev.clientX);
        const move = (m) => at(m.clientX);
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      // the view switch sits over the picture's bottom edge, outside its clipping, so a narrow clip does not cut it
      preview.replaceChildren(el("div", { class: "er-stagewrap" }, stage, modes));
    }
    const { width: w, height: h } = project.source;
    const portrait = w < h * 1.2;   // tall and square clips go side by side; wide ones one over the other
    // Split puts the two side by side for a tall clip, one over the other for a wide one
    const ratio = viewMode === "split" ? (portrait ? (2 * w) / h : w / (2 * h)) : w / h;
    stage.className = `er-stage2 mode-${viewMode} ${portrait ? "portrait" : "landscape"}`;
    stage.style.setProperty("--r", String(ratio));
    stage.style.setProperty("--wipe", `${wipe}%`);
    for (const b of preview.querySelectorAll(".er-modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === viewMode));
    stage.querySelector(".er-rendering").hidden = !rendering;
  }

  // ---------------- timeline
  let pps = 40;                 // pixels per second at this zoom
  const H = 54;                 // filmstrip height
  const PICK = 3;               // seconds the "+" box covers (less where the part is shorter)
  let playhead = null;
  let bubble = null;
  let scroller = null;
  function movePlayhead() {
    if (!playhead || !project) return;
    const x = now() * pps;
    playhead.style.transform = `translateX(${x}px)`;
    bubble.textContent = mmss(now());
    const time = transport.querySelector(".er-time b");
    if (time) time.textContent = mmss(now());
    // keep the playhead in view while playing
    if (!vFinal.paused && scroller && (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - 40)) scroller.scrollLeft = x - 40;
  }

  function editBlock(e, lv) {
    const entry = feed.get(e.entry);
    const done = entry?.status === "succeeded";
    const failed = entry && isDone(entry) && !done;
    const w = (e.end - e.start) * pps;
    const o = opById.get(e.op);
    const out = done ? entry.outputs.find((x) => x.type === "video")?.url : null;
    const body = out ? filmstrip(out, 0, e.end - e.start, w, H - 18, project.source.width / project.source.height)
      : el("div", { class: `er-block-body${failed ? " failed" : " busy"}` },
        failed ? "Failed" : entry ? statusText(entry) : "…",
        !failed && entry?.progress?.value > 0 ? el("i", { style: { width: `${Math.round(entry.progress.value * 100)}%` } }) : null);
    const b = el("button", { class: `er-block${e.id === selected ? " on" : ""}${failed ? " failed" : ""}`, type: "button", title: e.prompt || e.title,
      style: { left: `${e.start * pps}px`, width: `${w}px` }, dataset: { edit: e.id } },
      el("span", { class: "er-block-head" }, icon(o?.icon || "wand"), e.title), body);
    b.onclick = (ev) => {
      ev.stopPropagation();
      selected = e.id;
      drawTimeline();
      const fresh = timeline.querySelector(`[data-edit="${e.id}"]`) || b;
      popover(fresh, el("div", { class: "pad" },
        el("b", {}, `${e.title} · ${fmtRange(e.start, e.end)}`),
        el("p", { class: "help" }, `${engineInfo(e.engine).name} · ${entry ? (isDone(entry) ? entry.status : statusText(entry)) : "…"}`),
        e.prompt ? el("p", { class: "help" }, e.prompt) : null,
        failed && entry?.error?.message ? el("p", { class: "help", style: { color: "var(--bad)" } }, entry.error.message) : null,
        el("div", { class: "row" },
          out ? el("a", { class: "btn small ghost", href: out, download: `${project.name}-${e.op}.mp4` }, icon("download"), "This part") : null,
          el("button", { class: "btn small ghost", type: "button", onclick: () => { closePopover(); range = [e.start, e.end]; op = opById.get(e.op) || null; drawLeft(); drawTimeline(); } }, icon("redo"), "Again"),
          el("button", { class: "btn small ghost danger", type: "button", onclick: async () => {
            closePopover();
            try { project = await api(`/api/editroom/${project.id}/edits/${e.id}`, { method: "DELETE" }); selected = null; drawAll(); render(); }
            catch (err) { toast(err.message, { error: true }); }
          } }, icon("trash"), "Remove"))), { width: 320 });
    };
    b.style.setProperty("--lv", lv);
    return b;
  }

  function drawTimeline() {
    if (!project) { timeline.replaceChildren(); return; }
    const D = project.source.duration;
    const aspect = project.source.width / project.source.height;
    const prevScroll = scroller?.scrollLeft || 0;
    scroller = el("div", { class: "er-scroll" });
    const view = Math.max(200, (timeline.clientWidth || main.clientWidth || 900) - 56);
    pps = (view / D) * zoom;
    const W = D * pps;
    const lv = levels(project.edits);
    const rows = Math.max(0, ...lv.values());
    const x = (t) => `${t * pps}px`;

    playhead = el("div", { class: "er-playhead" });
    bubble = el("span", { class: "er-bubble" });
    playhead.append(bubble);
    const ruler = el("div", { class: "er-ruler" }, el("i", { style: { width: `${W}px` } }));
    const hint = el("span", { class: "er-hint", hidden: true }, "Click to add an effect to this part of the clip");

    // the add row: a "+" box a few seconds long under the pointer, kept inside the part it is in
    const addRow = el("div", { class: "er-row add" }, ...project.cuts.map((c) => el("i", { class: "er-div", style: { left: x(c) } })));
    const ghost = el("div", { class: "er-ghost", hidden: true }, icon("plus"));
    addRow.append(ghost);
    const pickAt = (t) => {
      const [a, b] = partAt(project, t);
      const len = Math.min(PICK, b - a);
      const s = clamp(Math.round((t - len / 2) * 10) / 10, a, b - len);
      return [s, Math.min(b, Math.round((s + len) * 100) / 100)];
    };
    addRow.addEventListener("pointermove", (ev) => {
      const [s, e] = pickAt((ev.clientX - addRow.getBoundingClientRect().left) / pps);
      ghost.hidden = false;
      hint.hidden = false;
      ghost.style.left = x(s);
      ghost.style.width = x(e - s);
      hint.style.left = x(s);
      ghost.dataset.s = s;
      ghost.dataset.e = e;
    });
    addRow.addEventListener("pointerleave", () => { ghost.hidden = true; hint.hidden = true; });
    addRow.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (ghost.hidden) return;
      range = [Number(ghost.dataset.s), Number(ghost.dataset.e)];
      op = null;
      seek(range[0]);
      drawLeft();
      drawTimeline();
    });
    // the part picked for the next edit: a box in the add row, a dashed frame on the clip with handles to stretch it
    if (range) {
      const label = op ? [icon(op.icon), op.title] : [icon("plus")];
      addRow.append(el("div", { class: "er-sel", style: { left: x(range[0]), width: x(range[1] - range[0]) } }, ...label));
    }

    const editRows = Array.from({ length: rows }, (_, i) => {
      const level = rows - i;
      return el("div", { class: "er-row" }, ...project.edits.filter((e) => lv.get(e.id) === level).map((e) => editBlock(e, level)));
    });

    // the clip, one rounded piece per part
    const base = el("div", { class: "er-row base" }, ...partsOf(project).map(([a, b]) =>
      el("div", { class: "er-seg", style: { left: x(a), width: x(b - a) } }, filmstrip(project.source_url, a, b - a, (b - a) * pps, H, aspect))));
    if (range) {
      const frame = el("div", { class: "er-frame", style: { left: x(range[0]), width: x(range[1] - range[0]) } },
        el("span", { class: "er-handle l", "aria-label": "Move the start" }), el("span", { class: "er-handle r", "aria-label": "Move the end" }));
      for (const hnd of frame.querySelectorAll(".er-handle")) {
        hnd.addEventListener("pointerdown", (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
          const isStart = hnd.classList.contains("l");
          const left0 = base.getBoundingClientRect().left;
          const move = (m) => {
            const t = Math.round(((m.clientX - left0) / pps) * 10) / 10;
            if (isStart) range[0] = clamp(t, 0, range[1] - 1);
            else range[1] = clamp(t, range[0] + 1, D);
            frame.style.left = x(range[0]);
            frame.style.width = x(range[1] - range[0]);
            const sel = addRow.querySelector(".er-sel");
            if (sel) { sel.style.left = frame.style.left; sel.style.width = frame.style.width; }
          };
          const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); drawLeft(); };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        });
      }
      base.append(frame);
    }

    const cuts = project.cuts.map((c) => el("div", { class: "er-cut", style: { left: x(c) } },
      el("button", { type: "button", title: `Remove the cut at ${mmss(c)}`, "aria-label": "Remove this cut", onclick: async (ev) => {
        ev.stopPropagation();
        await saveCuts(project.cuts.filter((t) => t !== c));
      } }, icon("scissors"))));

    const tracks = el("div", { class: "er-tracks", style: { width: `${W}px` } }, ruler, addRow, ...editRows, base, ...cuts, hint, playhead);
    // click or drag anywhere but a block, the add row or a handle to move the playhead
    tracks.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest(".er-block, .er-cut button, .er-row.add, .er-handle")) return;
      const at = (px) => seek((px - tracks.getBoundingClientRect().left) / pps);
      at(ev.clientX);
      const move = (m) => at(m.clientX);
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    scroller.append(tracks);
    timeline.replaceChildren(scroller);
    scroller.scrollLeft = prevScroll;
    movePlayhead();
  }

  async function saveCuts(cuts) {
    try {
      project = await api(`/api/editroom/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ cuts }) });
      drawTimeline();
    } catch (err) { toast(err.message, { error: true }); }
  }

  // ---------------- transport: play, sound, time, cut, zoom, full screen
  function drawTransport() {
    if (!project) { transport.replaceChildren(); return; }
    const playing = !vFinal.paused && !vFinal.ended;
    const zoomIn = el("button", { class: "er-round", type: "button", "aria-label": "Zoom in", onclick: () => setZoom(zoom * 1.5) }, icon("search"), "+");
    const zoomOut = el("button", { class: "er-round", type: "button", "aria-label": "Zoom out", onclick: () => setZoom(zoom / 1.5) }, icon("search"), "−");
    const slider = el("input", { type: "range", min: "1", max: "12", step: "0.1", value: String(zoom), "aria-label": "Zoom" });
    slider.style.setProperty("--p", `${((zoom - 1) / 11) * 100}%`);
    slider.addEventListener("input", () => setZoom(Number(slider.value), false));
    transport.replaceChildren(
      el("div", { class: "row" },
        el("button", { class: "er-round", type: "button", "aria-label": playing ? "Pause" : "Play", onclick: () => (playing ? vFinal.pause() : vFinal.play().catch(() => {})) }, icon(playing ? "pause" : "play")),
        el("button", { class: "er-round", type: "button", "aria-label": muted ? "Sound on" : "Sound off", onclick: () => { muted = !muted; vFinal.muted = muted; drawTransport(); } }, icon(muted ? "mute" : "volume")),
        el("span", { class: "er-time" }, el("b", {}, mmss(now())), ` / ${mmss(project.source.duration)}`)),
      el("button", { class: "er-cutbtn", type: "button", onclick: () => {
        const t = Math.round(now() * 100) / 100;
        if (t < 0.5 || t > project.source.duration - 0.5) return toast("Move the playhead into the clip first (at least half a second from either end).");
        if (project.cuts.some((c) => Math.abs(c - t) < 0.3)) return toast("There is a cut there already.");
        saveCuts([...project.cuts, t]);
      } }, icon("scissors"), "Cut here"),
      el("div", { class: "row er-zoom" }, zoomOut, slider, zoomIn,
        el("button", { class: "er-round", type: "button", "aria-label": "Full screen", onclick: () => preview.requestFullscreen?.() }, icon("expand"))));
  }
  function setZoom(z, redrawBar = true) {
    zoom = clamp(z, 1, 12);
    store.set("editroom.zoom", zoom);
    drawTimeline();
    if (redrawBar) drawTransport();
  }

  function drawAll() {
    drawLeft();
    drawHeader();
    drawPreview();
    drawTimeline();
    drawTransport();
  }

  // keyboard: space plays and pauses (outside text fields)
  const onKey = (e) => {
    if (e.code !== "Space" || !project || e.target.closest?.("input, textarea, select, button, [contenteditable]")) return;
    e.preventDefault();
    if (vFinal.paused) vFinal.play().catch(() => {}); else vFinal.pause();
  };
  window.addEventListener("keydown", onKey);
  const ro = new ResizeObserver(() => { if (project) drawTimeline(); });
  ro.observe(timeline);

  // edits move along in the feed: redraw their blocks, render once one finishes
  let lastStates = "";
  const off = feed.on(() => {
    if (!project) return;
    const states = project.edits.map((e) => { const x = feed.get(e.entry); return `${e.id}:${x?.status}:${Math.round((x?.progress?.value || 0) * 20)}`; }).join("|");
    if (states === lastStates) return;
    lastStates = states;
    drawTimeline();
    drawHeader();
    render();
  });
  feed.load().catch(() => {});

  drawAll();
  if (projectId) load(projectId);
  return {
    node, active: "edit",
    dispose: () => { disposed = true; off(); ro.disconnect(); window.removeEventListener("keydown", onKey); vFinal.pause(); vInput.pause(); },
  };
}

// ------------------------------------------------------------------ My videos
let videosTab = "projects";
function myVideosView() {
  const body = el("div", { class: "er-videos-body" });
  const tabs = el("div", { class: "er-subtabs", role: "tablist" });
  let projects = null;
  const draw = () => {
    tabs.replaceChildren(...[["projects", "layers", "Projects"], ["generations", "film", "Generations"]].map(([id, ic, label]) =>
      el("button", { type: "button", role: "tab", "aria-selected": String(videosTab === id), onclick: () => { videosTab = id; draw(); } }, icon(ic), label)));
    if (!projects) { body.replaceChildren(el("div", { class: "er-none" }, "Loading…")); return; }
    if (videosTab === "projects") {
      if (!projects.length) {
        body.replaceChildren(el("div", { class: "er-blank" }, el("p", {}, "Videos you edit will show up here."),
          el("a", { class: "btn", href: "#/edit/new" }, icon("plus"), "Upload video")));
        return;
      }
      body.replaceChildren(el("div", { class: "er-grid-cards" }, ...projects.map((p) => el("div", { class: "er-proj" },
        el("a", { href: `#/edit/${p.id}`, class: "er-proj-media" }, el("img", { src: p.poster, alt: "", loading: "lazy" }),
          el("span", { class: "tag dark" }, `${p.edits.length} ${p.edits.length === 1 ? "edit" : "edits"}`)),
        el("div", { class: "er-proj-txt" }, el("a", { href: `#/edit/${p.id}` }, el("b", {}, p.name), el("small", {}, `${secs(p.source.duration)} · ${ago(p.updated)}`)),
          deleteButton(async () => {
            await api(`/api/editroom/${p.id}`, { method: "DELETE" });
            if (store.get(LAST, null) === p.id) store.set(LAST, null);
            projects = projects.filter((x) => x.id !== p.id);
            draw();
          }))))));
    } else {
      const gens = projects.flatMap((p) => p.edits.map((e) => ({ p, e, entry: feed.get(e.entry) }))).filter((g) => g.entry?.status === "succeeded")
        .sort((a, b) => (a.e.created < b.e.created ? 1 : -1));
      if (!gens.length) {
        body.replaceChildren(el("div", { class: "er-blank" }, el("p", {}, "Finished edits will show up here.")));
        return;
      }
      body.replaceChildren(el("div", { class: "er-grid-cards" }, ...gens.map(({ p, e, entry }) => {
        const url = entry.outputs.find((o) => o.type === "video")?.url;
        const v = el("video", { src: `${url}#t=0.1`, muted: true, loop: true, playsinline: true, preload: "metadata" });
        v.muted = true;
        const card = el("div", { class: "er-proj" },
          el("a", { href: `#/edit/${p.id}`, class: "er-proj-media" }, v, el("span", { class: "tag dark" }, e.title)),
          el("div", { class: "er-proj-txt" }, el("a", { href: `#/edit/${p.id}` }, el("b", {}, p.name), el("small", {}, `${fmtRange(e.start, e.end)} · ${engineInfo(e.engine).name}`)),
            el("a", { class: "mini", href: url, download: `${p.name}-${e.op}.mp4`, title: "Download", "aria-label": "Download" }, icon("download"))));
        card.addEventListener("mouseenter", () => v.play().catch(() => {}));
        card.addEventListener("mouseleave", () => v.pause());
        return card;
      })));
    }
  };
  draw();
  Promise.all([api("/api/editroom"), feed.load().catch(() => {})]).then(([r]) => { projects = r.projects; draw(); })
    .catch((err) => { body.replaceChildren(el("div", { class: "er-none" }, err.message)); });
  const node = el("div", { class: "er er-videos" },
    el("section", { class: "er-main" }, el("div", { class: "er-bar" }, roomTabs("videos", store.get(LAST, null))), tabs, body));
  return { node, active: "edit" };
}
