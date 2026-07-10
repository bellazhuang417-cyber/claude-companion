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
  // done ✓ for the first minute after the turn ends (fresh celebration),
  // then switches to "needs reply" — matches Claude Desktop's "Needs input"
  // language for any completed turn the user hasn't replied to yet.
  if (s === "done") {
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
        permHtml = `
          <div class="action-title">● Permission requested · ${escapeHtml(p.tool || "tool")}</div>
          ${p.reason ? `<div class="preason">${escapeHtml(p.reason)}</div>` : ""}
          <div class="action-cmd">$ ${escapeHtml(p.command || "")}</div>
          <div class="pbtns">
            <button class="pbtn allow" data-decide="allow" data-sid="${escapeHtml(sess.session_id)}">✓ Allow</button>
            <button class="pbtn deny"  data-decide="deny"  data-sid="${escapeHtml(sess.session_id)}">✗ Deny</button>
          </div>`;
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

function renderPet() {
  const sprite = document.getElementById("sprite");
  const bubble = document.getElementById("bubble");
  const bt = document.getElementById("bubble-text");
  const bs = document.getElementById("bubble-sub");
  const src = petSrcFor(state.mood);
  if (sprite) sprite.src = src || "";
  const showBubble = state.bubbleText && state.mood !== "idle" && !state.expanded;
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

function updatePetFromSessions() {
  const pending = state.sessions.filter(s => s.effective_state === "pending");
  const perms   = pending.filter(s => s.pending_permission).length;
  if (pending.length > 0) {
    state.mood = "input";
    const who = state.petName;
    if (!who) { state.mood = "idle"; state.bubbleText = ""; state.bubbleSub = ""; return; }
    if (perms > 0) {
      state.bubbleText = pending.length === 1
        ? `${who}, a request needs your approval!`
        : `${who}, ${pending.length} requests need your approval!`;
    } else {
      state.bubbleText = pending.length === 1
        ? `${who}, a session is waiting for your reply~`
        : `${who}, ${pending.length} sessions are waiting for your reply~`;
    }
    state.bubbleSub = pending.map(s => s.project || "session").join(" · ");
  } else if (celebration) {
    state.mood = celebration.mood;
    state.bubbleText = celebration.text;
    state.bubbleSub = celebration.sub;
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
        console.log("skin installed:", result);
      }
    } catch (err) { console.warn("skin install failed", err); }
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
    else if (act === "quit") invoke("quit_app");
    e.preventDefault(); e.stopPropagation(); return;
  }
  if (e.target.closest("#bubble-close")) {
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

listen("sessions", (event) => {
  const p = event.payload;
  state.sessions = p.sessions || [];
  state.top = p.top || "idle";
  state.serverNow = p.now || Math.floor(Date.now() / 1000);
  state.clientNowAtPush = Math.floor(Date.now() / 1000);
  checkAnnouncements();
  updatePetFromSessions();
  render();
});
listen("skins", (event) => {
  state.skins = event.payload.skins || [];
  render();
});
// Menubar tray icon click → toggle the panel (same as clicking the pet).
listen("tray-click", () => { toggleExpand(); });

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
