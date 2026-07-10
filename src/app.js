// Claude Companion — v1.0 frontend.
// Reads real sessions/skins from Rust (which watches ~/.claude-menubar/).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const state = {
  petName: null,   // populated by get_pet_name on boot; null = don't build bubble text yet
  skin: "tac",
  skinManifest: null,
  skinAssets: {},
  sessions: [],
  top: "idle",
  serverNow: 0,
  clientNowAtPush: Math.floor(Date.now() / 1000),
  mood: "idle",
  bubbleText: "",
  bubbleSub: "",
  expanded: false,
  expandedSid: null,
  logs: {},           // sid → [{kind, text}] transcript tail
  lastAssistant: {},  // sid → full text of Claude's most recent message
  config: {},
  skins: [],
  // P0-2: dismissed signature — ported from HS petSignature/petDismissedSig.
  // When Bella × the bubble, we record the current pending batch's signature.
  // Same batch on next tick → bubble stays hidden. NEW batch (new pending
  // request) → signature changes → bubble comes back. Matches HS behavior.
  dismissedSig: null,
  shownSig: null,
  // P2-1: last emit signature — skip re-render if payload is byte-identical.
  lastSessionsHash: null,
};

function nowSeconds() {
  const wall = Math.floor(Date.now() / 1000);
  return state.serverNow + (wall - state.clientNowAtPush);
}
function formatAge(u) {
  const age = Math.max(0, nowSeconds() - (u || 0));
  if (age < 5) return "now";
  if (age < 60) return age + "s";
  if (age < 3600) return Math.floor(age / 60) + "m";
  if (age < 86400) return Math.floor(age / 3600) + "h";
  return Math.floor(age / 86400) + "d";
}
function shortCwd(cwd) {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return ".../" + parts.slice(-2).join("/");
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// P2-4: lightweight toast at the top of the panel. Auto-dismisses.
function showToast(msg, kind = "ok") {
  let el = document.getElementById("companion-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "companion-toast";
    document.body.appendChild(el);
  }
  el.className = `companion-toast ${kind}`;
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.style.opacity = "0"; }, 3500);
}

async function loadSkin(name) {
  state.skin = name;
  state.skinAssets = {};
  if (name === "tac") { state.skinManifest = null; return; }
  try {
    const mf = await invoke("get_skin_manifest", { name });
    state.skinManifest = mf;
    if (mf.gifs) {
      for (const [mood, file] of Object.entries(mf.gifs)) {
        try {
          state.skinAssets[mood] = await invoke("get_skin_asset", { skin: name, file });
        } catch (e) { console.warn("asset load fail", mood, file, e); }
      }
    }
  } catch (e) {
    console.warn("manifest load fail", e);
    state.skinManifest = null;
  }
}

function petSrcFor(mood) {
  const a = state.skinAssets;
  return a[mood] || a.input || a.idle || "";
}

function statusLabel(s, hasPerm, ageSec) {
  if (s === "running") return `<span class="stx work">working</span>`;
  if (s === "pending") return hasPerm ? `<span class="stx">needs permission</span>`
                                       : `<span class="stx">needs reply</span>`;
  if (s === "done") {
    // First 60s post-turn: green celebration. After that: "needs reply" —
    // Bella clicks to expand and reads Claude's last message to decide
    // whether it's a question or just a completion.
    if ((ageSec || 0) < 60) return `<span class="stx done">done ✓</span>`;
    return `<span class="stx">needs reply</span>`;
  }
  return `<span class="stx idle">idle</span>`;
}

function renderSessions() {
  const container = document.getElementById("sess-list");
  if (!container) return;
  const list = state.sessions;
  const counts = { running: 0, pending: 0, done: 0 };
  list.forEach((s) => { if (counts[s.effective_state] != null) counts[s.effective_state]++; });
  const cr = document.getElementById("cnt-run");
  const cw = document.getElementById("cnt-wait");
  const cd = document.getElementById("cnt-done");
  const hc = document.getElementById("head-count");
  if (cr) cr.textContent  = counts.running;
  if (cw) cw.textContent = counts.pending;
  if (cd) cd.textContent = counts.done;
  if (hc) hc.textContent = "· " + list.length + (list.length === 1 ? " session" : " sessions");

  if (list.length === 0) {
    container.innerHTML = '<div class="empty">No active sessions.</div>';
    return;
  }
  let html = "";
  list.forEach((sess) => {
    const st = sess.effective_state;
    const hasPerm = !!sess.pending_permission;
    const expanded = state.expandedSid === sess.session_id;
    html += `
      <div class="sess ${expanded ? "expanded" : ""}"
           data-sid="${escapeHtml(sess.session_id)}" data-status="${escapeHtml(st)}">
        <div class="av"></div>
        <div class="mid">
          <div class="nm">${escapeHtml(sess.title || sess.label || "(no recent message)")}</div>
          <div class="meta">${escapeHtml(sess.project || "session")} · ${statusLabel(st, hasPerm, nowSeconds() - (sess.updated_at || 0))}
            ${sess.cwd ? ` · <span class="cwd">${escapeHtml(shortCwd(sess.cwd))}</span>` : ""}
          </div>
        </div>
        <div class="right">${formatAge(sess.updated_at)} <span class="caret">›</span></div>
      </div>
    `;
    if (expanded) {
      // What Claude actually said last — this is what Bella needs to read
      // before she can reply. Shown at the top, full text, no truncation.
      const lastMsg = state.lastAssistant[sess.session_id];
      let waitingHtml = "";
      if (st === "done" || (st === "pending" && !hasPerm)) {
        if (lastMsg === undefined) {
          waitingHtml = `<div class="last-assistant loading">Loading Claude's last message…</div>`;
        } else if (lastMsg) {
          waitingHtml = `<div class="last-assistant">
            <div class="la-label">Claude's last message</div>
            <div class="la-text">${escapeHtml(lastMsg)}</div>
          </div>`;
        }
      }
      // Transcript log tail (loaded async on expand)
      const lines = state.logs[sess.session_id];
      let logHtml = "";
      if (lines && lines.length) {
        logHtml = lines.map(ln => {
          const pfx = ln.kind === "user" ? "›" : ln.kind === "tool" ? "⏵" : "·";
          return `<div class="ln ${escapeHtml(ln.kind)}"><span class="pfx">${pfx}</span>${escapeHtml(ln.text)}</div>`;
        }).join("");
      } else if (lines) {
        logHtml = `<div class="ln empty">No transcript content yet.</div>`;
      } else {
        logHtml = `<div class="ln empty">Loading log…</div>`;
      }
      let permHtml = "";
      if (hasPerm) {
        const p = sess.pending_permission;
        // P0-1: hook only waits REMOTE_WINDOW seconds before it gives up
        // and falls back to the in-window dialog. Past that, clicking
        // Allow here writes a decision file nobody consumes — total
        // ghost button. Ported from Hammerspoon v0.3.9 behavior.
        const REMOTE_WINDOW = 120;
        const reqAge = nowSeconds() - (p.requested_at || sess.updated_at || 0);
        const remoteAlive = p.requested_at && reqAge < REMOTE_WINDOW;
        const buttonsHtml = remoteAlive
          ? `<div class="pbtns">
              <button class="pbtn allow" data-decide="allow" data-sid="${escapeHtml(sess.session_id)}">✓ Allow</button>
              <button class="pbtn deny"  data-decide="deny"  data-sid="${escapeHtml(sess.session_id)}">✗ Deny</button>
            </div>
            <div class="premote">remote window ${Math.max(0, Math.round(REMOTE_WINDOW - reqAge))}s</div>`
          : `<div class="pexpired">远程确认已超时 — 请到 Claude Code 窗口处理</div>`;
        permHtml = `
          <div class="action-title">● Permission requested · ${escapeHtml(p.tool || "tool")}</div>
          ${p.reason ? `<div class="preason">${escapeHtml(p.reason)}</div>` : ""}
          <div class="action-cmd">$ ${escapeHtml(p.command || "")}</div>
          ${buttonsHtml}`;
      }
      html += `
        <div class="sess-detail">
          ${waitingHtml}
          <div class="log">${logHtml}</div>
          ${permHtml}
        </div>
      `;
    }
  });
  container.innerHTML = html;
}

function renderSkins() {
  const tabs = document.getElementById("sp-tabs");
  if (!tabs) return;
  tabs.innerHTML = state.skins.map(s => `
    <button class="sp-tab ${s.active ? "active" : ""}" data-skin="${escapeHtml(s.name)}">
      ${escapeHtml(s.displayName || s.name)}${
        s.name !== "tac"
          ? `<span class="sp-del" data-del-skin="${escapeHtml(s.name)}" title="Delete this skin">×</span>`
          : ""
      }
    </button>
  `).join("");
}

// P0-2 helper: signature of the current pending batch. Same input →
// same signature. Change → bubble may reappear even after user dismissed.
function pendingSignature() {
  const parts = [];
  for (const s of state.sessions) {
    if (s.effective_state === "pending") {
      const p = s.pending_permission;
      parts.push(s.session_id + ":" + (p && p.requested_at ? p.requested_at : "wait"));
    }
  }
  parts.sort();
  return parts.join("|");
}

function renderPet() {
  const sprite = document.getElementById("sprite");
  const bubble = document.getElementById("bubble");
  const bt = document.getElementById("bubble-text");
  const bs = document.getElementById("bubble-sub");
  const src = petSrcFor(state.mood);
  if (sprite) sprite.src = src || "";

  // P0-2: honor dismissedSig — if user dismissed the current pending batch,
  // keep the bubble hidden until the batch actually changes.
  const sig = pendingSignature();
  let showBubble = state.bubbleText && state.mood !== "idle" && !state.expanded;
  if (showBubble && sig && sig === state.dismissedSig) showBubble = false;
  // Once the batch changes, clear the dismissed marker so the next batch
  // gets a fresh chance to alert.
  if (sig !== state.dismissedSig) state.dismissedSig = null;
  state.shownSig = showBubble ? sig : null;

  if (bubble) {
    bubble.hidden = !showBubble;
    if (showBubble && bt) {
      bt.textContent = state.bubbleText;
      bs.textContent = state.bubbleSub || "";
      bs.style.display = state.bubbleSub ? "" : "none";
      bubble.setAttribute("data-mood", state.mood);
    }
  }
}

function render() {
  document.body.classList.toggle("mode-expanded", state.expanded);
  document.body.classList.toggle("mode-idle", !state.expanded);
  renderSessions(); renderSkins(); renderPet();
}

// ---------- Announcements (done ✓ / still-on-it review) ----------
// Ported from Hammerspoon announceDone / announceReview. Notification
// channel per Bella's choice: pet bubble ONLY, no system notifications.
const announced = { done: new Set(), review: new Set() };
let celebration = null;   // { mood, text, sub, timer } — overrides idle
// P1-3: first payload should register existing done/running sessions as
// "already known" so we don't replay yesterday's celebrations at startup.
let announceInitialized = false;

function longTaskSeconds() {
  return Number((state.config || {}).long_task_seconds) || 120;
}

function formatDur(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  if (sec >= 3600) return Math.floor(sec / 3600) + "h" + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") + "m";
  if (sec >= 60) return Math.floor(sec / 60) + "m";
  return sec + "s";
}

function setCelebration(mood, text, sub, lingerMs) {
  if (celebration && celebration.timer) clearTimeout(celebration.timer);
  celebration = { mood, text, sub };
  celebration.timer = setTimeout(() => {
    celebration = null;
    updatePetFromSessions();
    render();
  }, lingerMs);
}

function checkAnnouncements() {
  const who = state.petName;
  if (!who) return;   // wait for get_pet_name to resolve before announcing
  // P1-3: on the very first payload, silently register everything so we
  // don't spam Bella with a stream of stale "task finished ✓" bubbles
  // from turns that completed while the app was closed.
  if (!announceInitialized) {
    for (const s of state.sessions) {
      if (s.effective_state === "done") announced.done.add(s.session_id + ":" + s.updated_at);
      if (s.effective_state === "running" && s.running_since) {
        announced.review.add(s.session_id + ":" + s.running_since);
      }
    }
    announceInitialized = true;
    return;
  }
  const threshold = longTaskSeconds();
  const anyPending = state.sessions.some(s => s.effective_state === "pending");

  // Long-task completion → celebration (pending call-outs take priority)
  for (const s of state.sessions) {
    if (s.effective_state === "done" && (s.turn_duration || 0) >= threshold) {
      const key = s.session_id + ":" + s.updated_at;
      if (!announced.done.has(key)) {
        announced.done.add(key);
        if (!anyPending) {
          const task = s.title || s.label || s.project || "session";
          setCelebration("done", `${who}, task finished ✓`,
            `${task}  ·  ${s.project || ""} · ran ${formatDur(s.turn_duration)}`, 25000);
        }
      }
    }
  }
  // Long-running check-in → review mood, once per turn
  if (!anyPending && !celebration) {
    for (const s of state.sessions) {
      if (s.effective_state === "running" && s.running_since) {
        const elapsed = nowSeconds() - s.running_since;
        if (elapsed >= threshold) {
          const key = s.session_id + ":" + s.running_since;
          if (!announced.review.has(key)) {
            announced.review.add(key);
            setCelebration("review", `${who}, still on it…`,
              `${s.title || s.label || s.project || ""}  ·  running ${formatDur(elapsed)}`, 12000);
            break;
          }
        }
      }
    }
  }
}

// Full state matrix — every effective_state maps to a definite pet mood
// so the pet visual never disagrees with the panel labels. Priority
// order (top wins): user-facing celebration > pending-perm > pending-reply
// or stale-done > running > all-idle.
function updatePetFromSessions() {
  const now = nowSeconds();
  const s = state.sessions;
  const pendingPerm  = s.filter(x => x.effective_state === "pending" && x.pending_permission);
  const pendingReply = s.filter(x => x.effective_state === "pending" && !x.pending_permission);
  const staleDone    = s.filter(x => x.effective_state === "done" && (now - (x.updated_at || 0)) >= 60);
  const running      = s.filter(x => x.effective_state === "running");
  const who = state.petName;

  // Celebration timer (task finished / still on it) overrides idle / running.
  if (celebration) {
    state.mood = celebration.mood;
    state.bubbleText = celebration.text;
    state.bubbleSub = celebration.sub;
    return;
  }
  if (!who) { state.mood = "idle"; state.bubbleText = ""; state.bubbleSub = ""; return; }

  if (pendingPerm.length > 0) {
    state.mood = "input";
    state.bubbleText = pendingPerm.length === 1
      ? `${who}, a request needs your approval!`
      : `${who}, ${pendingPerm.length} requests need your approval!`;
    state.bubbleSub = pendingPerm.map(x => x.project || "session").join(" · ");
  } else if (pendingReply.length + staleDone.length > 0) {
    // Panel label is "needs reply" for both pending-no-perm and done-≥60s;
    // pet matches with the input running mood so nothing looks stalled.
    const list = [...pendingReply, ...staleDone];
    state.mood = "input";
    state.bubbleText = list.length === 1
      ? `${who}, a session is waiting for your reply~`
      : `${who}, ${list.length} sessions are waiting for your reply~`;
    state.bubbleSub = list.map(x => x.project || "session").join(" · ");
  } else if (running.length > 0) {
    // Something in flight, no user action required. Pet looks thoughtful
    // (review = Musk's thinking pose) but stays quiet — no bubble.
    state.mood = "review";
    state.bubbleText = ""; state.bubbleSub = "";
  } else {
    state.mood = "idle";
    state.bubbleText = ""; state.bubbleSub = "";
  }
}

async function toggleExpand() {
  state.expanded = !state.expanded;
  const h = state.expanded ? 760 : 220;
  try { await invoke("resize_window", { width: 380, height: h }); } catch (e) {}
  render();
}

document.addEventListener("click", async (e) => {
  const decideBtn = e.target.closest("[data-decide]");
  if (decideBtn) {
    const sid = decideBtn.getAttribute("data-sid");
    const behavior = decideBtn.getAttribute("data-decide");
    try { await invoke("decide", { sid, behavior }); } catch (err) { console.warn(err); }
    const sess = state.sessions.find(s => s.session_id === sid);
    if (sess) { sess.pending_permission = null; sess.effective_state = "running"; }
    state.expandedSid = null;
    render();
    e.preventDefault(); e.stopPropagation(); return;
  }
  const row = e.target.closest(".sess");
  if (row) {
    const sid = row.getAttribute("data-sid");
    state.expandedSid = state.expandedSid === sid ? null : sid;
    render();
    // Fetch transcript tail + Claude's last full message asynchronously
    if (state.expandedSid === sid) {
      const sess = state.sessions.find(s => s.session_id === sid);
      if (sess && sess.transcript_path) {
        invoke("get_transcript_tail", { path: sess.transcript_path, n: 6 })
          .then(lines => { state.logs[sid] = lines || []; render(); })
          .catch(() => {});
        // Full text of Claude's last message — the "what am I waiting for" content
        invoke("get_last_assistant_message", { path: sess.transcript_path })
          .then(text => { state.lastAssistant[sid] = text || ""; render(); })
          .catch(() => {});
      }
    }
    e.preventDefault(); e.stopPropagation(); return;
  }
  // Install skin from zip (native file picker, defaults to ~/Downloads)
  if (e.target.closest("#skin-add")) {
    try {
      const picked = await window.__TAURI__.dialog.open({
        title: "Pick a pet skin .zip",
        filters: [{ name: "Zip", extensions: ["zip"] }],
        multiple: false,
      });
      if (picked) {
        const result = await invoke("install_skin_zip", { zipPath: picked });
        const payload = await invoke("get_skins");
        state.skins = payload.skins || [];
        render();
        // P2-4: visible confirmation — before this, Bella got zero feedback.
        showToast(`✓ Installed skin: ${result.displayName || result.slug}`, "ok");
      }
    } catch (err) {
      showToast(`✗ Install failed: ${err && err.toString ? err.toString() : err}`, "err");
    }
    e.preventDefault(); e.stopPropagation(); return;
  }
  // Skin delete × (must be checked BEFORE the tab click — × sits inside the tab)
  const delBtn = e.target.closest("[data-del-skin]");
  if (delBtn) {
    const name = delBtn.getAttribute("data-del-skin");
    const label = delBtn.closest(".sp-tab")?.textContent?.replace("×", "").trim() || name;
    if (window.confirm(`Delete skin "${label}"?\n删除皮肤「${label}」？文件将从磁盘移除。`)) {
      try {
        const payload = await invoke("delete_skin", { name });
        state.skins = payload.skins || [];
        // If the deleted skin was in use, backend already fell back to tac.
        if (state.skin === name) await loadSkin("tac");
        render();
      } catch (err) { console.warn("delete failed", err); }
    }
    e.preventDefault(); e.stopPropagation(); return;
  }
  const sb = e.target.closest("[data-skin]");
  if (sb) {
    const name = sb.getAttribute("data-skin");
    try {
      const payload = await invoke("set_skin", { name });
      state.skins = payload.skins || [];
      await loadSkin(name);
      render();
    } catch (err) { console.warn(err); }
    e.preventDefault(); e.stopPropagation(); return;
  }
  const ab = e.target.closest("[data-action]");
  if (ab) {
    const act = ab.getAttribute("data-action");
    if (act === "toggle-expand") toggleExpand();
    else if (act === "quit") {
      // P2-3: confirm before killing the whole monitoring app.
      if (window.confirm("Quit Claude Companion? 宠物和菜单栏 cc 图标都会消失,重启 App 才会回来。")) {
        invoke("quit_app");
      }
    }
    else if (act === "reset-position") {
      // P1-1: rescue-hatch when the pet is stranded off-screen (multi-monitor pull).
      try { await invoke("reset_pet_position"); showToast("Pet position reset", "ok"); }
      catch (err) { showToast("Reset failed: " + err, "err"); }
    }
    e.preventDefault(); e.stopPropagation(); return;
  }
  if (e.target.closest("#bubble-close")) {
    // P0-2: record the current pending signature so this batch stays
    // silent until it actually changes. Also cancel any celebration
    // currently showing (Bella actively said "I'm done with this").
    state.dismissedSig = pendingSignature();
    if (celebration && celebration.timer) clearTimeout(celebration.timer);
    celebration = null;
    document.getElementById("bubble").hidden = true;
    e.preventDefault(); e.stopPropagation(); return;
  }
  if (e.target.closest("#pet-body")) {
    // If this click is the tail end of a drag, swallow it.
    if (petDrag.suppressClick) { petDrag.suppressClick = false; e.preventDefault(); return; }
    toggleExpand();
    e.preventDefault(); e.stopPropagation(); return;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.expanded) toggleExpand();
});

// Drag: mousedown anywhere EXCEPT on genuinely interactive elements starts
// a native window drag. That includes empty panel space (header background,
// gutter between rows, footer background) — so Bella can grab the panel
// itself to move the window without hunting for tiny transparent corners.
// Empty areas (panel background, transparent margins): drag immediately.
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(
    "#pet-body, .bubble, .sess, button, input, textarea, [data-decide], [data-skin], [data-action]"
  )) return;
  invoke("start_drag");
});

// Pet body: click = toggle panel, drag = move window. A 5px movement
// threshold distinguishes the two (same trick as the Hammerspoon version).
const petDrag = { armed: false, startX: 0, startY: 0, suppressClick: false };
document.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (!e.target.closest("#pet-body")) return;
  petDrag.armed = true;
  petDrag.startX = e.screenX;
  petDrag.startY = e.screenY;
});
document.addEventListener("mousemove", (e) => {
  if (!petDrag.armed) return;
  const dx = e.screenX - petDrag.startX;
  const dy = e.screenY - petDrag.startY;
  if (dx * dx + dy * dy >= 25) {   // 5px threshold
    petDrag.armed = false;
    petDrag.suppressClick = true;  // the mouseup click is a drag tail, not a toggle
    invoke("start_drag");
  }
});
document.addEventListener("mouseup", () => { petDrag.armed = false; });

// Persist the window position after any move (drag ends → moved events stop).
(async () => {
  try {
    const win = window.__TAURI__.window.getCurrentWindow();
    let saveTimer = null;
    await win.onMoved(async (ev) => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          const scale = await win.scaleFactor();
          const size = await win.outerSize();
          const x = ev.payload.x / scale;
          const yBottom = (ev.payload.y + size.height) / scale;
          await invoke("save_pet_position", { x, yBottom });
        } catch (err) { console.warn("save pos fail", err); }
      }, 400);
    });
  } catch (e) { console.warn("onMoved unavailable", e); }
})();

// P2-1 + P2-7: dedupe sessions push. Rust polls every 3s and re-emits
// regardless of content; if the payload is byte-identical to last time
// there's no reason to re-render (was resetting scroll position and
// wasting CPU). Only skip DOM work — timer state stays intact.
function sessionsFingerprint(list) {
  // Strip volatile fields (running_since drift <1s doesn't warrant rerender).
  return list.map(s => [
    s.session_id, s.effective_state, s.updated_at,
    s.title || "", s.project || "",
    s.pending_permission ? (s.pending_permission.command || "") : "",
    s.pending_permission ? s.pending_permission.requested_at || 0 : 0,
    s.turn_duration || 0,
  ].join("|")).join("\n");
}

listen("sessions", (event) => {
  const p = event.payload;
  state.sessions = p.sessions || [];
  state.top = p.top || "idle";
  state.serverNow = p.now || Math.floor(Date.now() / 1000);
  state.clientNowAtPush = Math.floor(Date.now() / 1000);
  const fp = sessionsFingerprint(state.sessions);
  const changed = fp !== state.lastSessionsHash;
  state.lastSessionsHash = fp;
  checkAnnouncements();
  updatePetFromSessions();
  // Content unchanged → keep DOM (and Bella's scroll position). Still
  // updatePetFromSessions so bubble reflects new "clock time".
  if (changed) {
    render();
  } else {
    // Just refresh pet artwork/bubble; skip the heavy session-list DOM rebuild.
    renderPet();
  }
});
listen("skins", (event) => {
  state.skins = event.payload.skins || [];
  render();
});
// Menubar tray icon click → toggle the panel (same as clicking the pet).
listen("tray-click", () => { toggleExpand(); });

// ---------- P0-3: click-through for transparent regions ----------
// The window rectangle is fully opaque to clicks by default, even where
// pixels are transparent — that's how Musk-standing-in-the-corner blocked
// Bella from clicking on Claude Desktop underneath. Fix: track cursor
// position; when it's over a visible element (pet, bubble, panel),
// disable ignore-cursor-events; when it's over transparent air, enable
// it so clicks pass through to whatever's behind.
let clickThroughOn = false;
async function setClickThrough(on) {
  if (on === clickThroughOn) return;
  clickThroughOn = on;
  try { await invoke("set_click_through", { ignore: on }); } catch (e) {}
}
function interactiveHitAt(x, y) {
  // In expanded mode, the entire panel is interactive → whole window.
  if (state.expanded) return true;
  // Idle mode: only over #pet-wrap counts (contains pet body + bubble).
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  return !!el.closest("#pet-wrap");
}
document.addEventListener("mousemove", (e) => {
  const alive = interactiveHitAt(e.clientX, e.clientY);
  setClickThrough(!alive);
});
// When the window loses hover entirely (cursor left our frame), enable
// click-through so we're not silently intercepting clicks off-window.
document.addEventListener("mouseleave", () => setClickThrough(true));
document.addEventListener("mouseenter", (e) => {
  setClickThrough(!interactiveHitAt(e.clientX, e.clientY));
});

// First-run autostart prompt (per Bella's install decision: ask once).
async function maybePromptAutostart(cfg) {
  if (cfg.autostart_prompted) return;
  try {
    const auto = window.__TAURI__.autostart;
    const wantIt = window.confirm(
      "Start Claude Companion automatically when you log in?\n\n" +
      "开机自动启动 Claude Companion？（只问这一次，之后可在系统设置 → 登录项 修改）"
    );
    if (wantIt) await auto.enable();
    await invoke("mark_autostart_prompted");
  } catch (e) { console.warn("autostart prompt failed", e); }
}

(async () => {
  state.petName = await invoke("get_pet_name").catch(() => "master");
  const cfg = await invoke("get_config").catch(() => ({}));
  state.config = cfg;
  const initSkin = cfg.skin || "tac";
  await loadSkin(initSkin);
  const skinsResp = await invoke("get_skins").catch(() => ({ skins: [] }));
  state.skins = skinsResp.skins || [];
  const sessResp = await invoke("get_sessions").catch(() => ({ sessions: [] }));
  state.sessions = sessResp.sessions || [];
  state.top = sessResp.top || "idle";
  state.serverNow = sessResp.now || Math.floor(Date.now() / 1000);
  state.clientNowAtPush = Math.floor(Date.now() / 1000);
  checkAnnouncements();
  updatePetFromSessions();
  render();
  maybePromptAutostart(cfg);
})();
