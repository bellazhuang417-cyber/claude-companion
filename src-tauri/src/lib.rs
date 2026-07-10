// Claude Companion — Tauri v2 (v1.0 complete)
// Full replacement for the Hammerspoon menubar plugin:
//   - watches ~/.claude-menubar/status.json, pushes sessions to the webview
//   - state reconciliation (transcript ground truth, TTL/expiry rules)
//   - menubar tray "cc N" with pending marker
//   - remote Allow/Deny via ~/.claude-menubar/decisions/<sid>.json
//   - skin discovery / switching / zip install (~/.claude-menubar/skins/)
//   - transcript tail for the expanded session log

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, State};

// ---------- Paths ----------
fn menubar_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude-menubar")
}
fn status_path() -> PathBuf { menubar_dir().join("status.json") }
fn decisions_dir() -> PathBuf { menubar_dir().join("decisions") }
fn config_path() -> PathBuf { menubar_dir().join("config.json") }
fn skins_dir() -> PathBuf { menubar_dir().join("skins") }

struct AppState {
    _watcher: Mutex<Option<RecommendedWatcher>>,
}

// ---------- JSON helpers ----------
fn read_status_json() -> serde_json::Value {
    match std::fs::read_to_string(status_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(serde_json::json!({"sessions": {}})),
        Err(_) => serde_json::json!({"sessions": {}}),
    }
}

fn read_config_json() -> serde_json::Value {
    match std::fs::read_to_string(config_path()) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

fn write_config_json(cfg: &serde_json::Value) -> Result<(), String> {
    std::fs::create_dir_all(menubar_dir()).map_err(|e| e.to_string())?;
    std::fs::write(config_path(), serde_json::to_string_pretty(cfg).unwrap_or_default())
        .map_err(|e| e.to_string())
}

// ---------- State reconciliation (ported from Hammerspoon init.lua) ----------
// SESSION_TTL is the only hard cutoff — matches Claude Desktop's own
// "unarchived and recent" definition. done / pending do NOT auto-expire
// into idle any more: Claude UI shows "Needs input" for any completed
// turn until the user replies, so silently converting to idle disagrees
// with the UI. Falling out of view happens via TTL only.
const SESSION_TTL: i64 = 24 * 3600;

fn transcript_last_event(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let start = size.saturating_sub(64 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    let mut last: Option<String> = None;
    for line in buf.lines() {
        let Ok(d) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" { continue; }
        let Some(msg) = d.get("message") else { continue };
        let content = msg.get("content");
        let mut kind: Option<String> = None;
        if let Some(parts) = content.and_then(|c| c.as_array()) {
            let mut saw_text = false;
            for part in parts {
                match part.get("type").and_then(|v| v.as_str()) {
                    Some("tool_use") => kind = Some("tool_use".into()),
                    Some("tool_result") => kind = Some("tool_result".into()),
                    Some("text") => {
                        let txt = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !txt.trim().is_empty() { saw_text = true; }
                    }
                    _ => {}
                }
            }
            if kind.is_none() && saw_text { kind = Some(t.to_string()); }
        } else if let Some(s) = content.and_then(|c| c.as_str()) {
            if !s.trim().is_empty() && !s.starts_with('<') { kind = Some(t.to_string()); }
        }
        if kind.is_some() { last = kind; }
    }
    last
}

fn effective_state(sess: &serde_json::Value, _now: i64) -> String {
    let raw = sess.get("state").and_then(|v| v.as_str()).unwrap_or("idle").to_string();
    let updated_at = sess.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut state = raw;

    // Transcript reconciliation still runs — it corrects hook drift.
    if let Some(tp) = sess.get("transcript_path").and_then(|v| v.as_str()) {
        if !tp.is_empty() {
            if let Ok(meta) = std::fs::metadata(tp) {
                let mtime = meta.modified().ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64).unwrap_or(0);
                if mtime > updated_at + 2 {
                    match transcript_last_event(tp).as_deref() {
                        Some("user") | Some("tool_use") | Some("tool_result") => state = "running".into(),
                        Some("assistant") => state = "done".into(),
                        _ => {}
                    }
                }
            }
        }
    }
    state
}

// Classify a "done" turn: is Claude asking a question / awaiting a
// decision, or was it a task-completion message that needs no reply?
// Heuristic: if the last non-empty sentence of Claude's last message
// ends with '?' (or Chinese '？' / full-width '？') → decision. Fragile
// on prose that ends mid-question inside code fences, but catches the
// common cases; refine as Bella flags mistakes.
fn classify_done(sess: &serde_json::Value) -> &'static str {
    let Some(tp) = sess.get("transcript_path").and_then(|v| v.as_str()) else { return "completed" };
    let Some(text) = last_assistant_text(tp) else { return "completed" };
    // Strip trailing whitespace / bullet markers, then check final char.
    let trimmed = text.trim_end_matches(|c: char| c.is_whitespace() || c == '*' || c == '·' || c == '-' || c == ')' );
    if let Some(last) = trimmed.chars().last() {
        if last == '?' || last == '？' { return "decision"; }
    }
    // Also catch questions that end with a period after "let me know" phrasing:
    // scan the tail for common decision-seeking cues.
    let tail: String = text.chars().rev().take(400).collect::<String>().chars().rev().collect();
    let low = tail.to_lowercase();
    let cues = ["should i ", "which would you", "would you like", "would you prefer",
        "let me know", "your call", "do you want", "confirm ", "sound good",
        "拍板", "让我知道", "帮我确认", "确认一下", "怎么选", "哪个", "同意吗"];
    if cues.iter().any(|c| low.contains(c) || tail.contains(c)) { return "decision"; }
    "completed"
}

// Extract Claude's last full assistant text (used by classify_done and
// exposed via get_last_assistant_message). Kept as a plain fn so both
// paths share one implementation.
fn last_assistant_text(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let start = size.saturating_sub(512 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    let mut latest: Option<String> = None;
    for line in buf.lines() {
        let Ok(d) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if d.get("type").and_then(|v| v.as_str()) != Some("assistant") { continue; }
        let Some(msg) = d.get("message") else { continue };
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => {
                let mut acc = String::new();
                for p in parts {
                    if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                            if !acc.is_empty() { acc.push('\n'); }
                            acc.push_str(t);
                        }
                    }
                }
                acc
            }
            _ => String::new(),
        };
        let trimmed = text.trim();
        if !trimmed.is_empty() { latest = Some(trimmed.to_string()); }
    }
    latest
}

fn build_sessions_payload() -> serde_json::Value {
    let status = read_status_json();
    let now_epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64).unwrap_or(0);

    let mut list: Vec<serde_json::Value> = Vec::new();
    if let Some(sessions) = status.get("sessions").and_then(|s| s.as_object()) {
        for (sid, sess) in sessions {
            let updated_at = sess.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
            if now_epoch - updated_at > SESSION_TTL { continue; }
            let eff = effective_state(sess, now_epoch);
            let done_kind = if eff == "done" { classify_done(sess) } else { "" };
            let mut clone = sess.clone();
            if let Some(obj) = clone.as_object_mut() {
                obj.insert("session_id".into(), serde_json::Value::String(sid.clone()));
                obj.insert("effective_state".into(), serde_json::Value::String(eff.clone()));
                if !done_kind.is_empty() {
                    obj.insert("done_kind".into(), serde_json::Value::String(done_kind.into()));
                }
                if eff != "pending" {
                    obj.insert("pending_permission".into(), serde_json::Value::Null);
                }
            }
            list.push(clone);
        }
    }
    list.sort_by(|a, b| {
        let pa = a.get("effective_state").and_then(|v| v.as_str()) == Some("pending");
        let pb = b.get("effective_state").and_then(|v| v.as_str()) == Some("pending");
        match (pa, pb) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => {
                let ua = a.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
                let ub = b.get("updated_at").and_then(|v| v.as_i64()).unwrap_or(0);
                ub.cmp(&ua)
            }
        }
    });

    let has_pending = list.iter().any(|s| s.get("effective_state").and_then(|v| v.as_str()) == Some("pending"));
    let has_running = list.iter().any(|s| s.get("effective_state").and_then(|v| v.as_str()) == Some("running"));
    let top = if has_pending { "pending" } else if has_running { "running" } else { "idle" };

    serde_json::json!({ "sessions": list, "top": top, "now": now_epoch })
}

// Build payload, refresh the tray title, and emit to the webview.
fn push_sessions(app: &tauri::AppHandle) {
    let payload = build_sessions_payload();
    if let Some(tray) = app.tray_by_id("cc") {
        let list = payload.get("sessions").and_then(|v| v.as_array());
        let n_active = list.map(|l| l.iter().filter(|s| {
            let st = s.get("effective_state").and_then(|v| v.as_str()).unwrap_or("");
            st == "running" || st == "pending"
        }).count()).unwrap_or(0);
        let top = payload.get("top").and_then(|v| v.as_str()).unwrap_or("idle");
        let title = if n_active == 0 { "cc".to_string() }
            else if top == "pending" { format!("cc {} !", n_active) }
            else { format!("cc {}", n_active) };
        let _ = tray.set_title(Some(title));
    }
    let _ = app.emit("sessions", payload);
}

fn build_skins_payload() -> serde_json::Value {
    let mut skins = vec![serde_json::json!({
        "name": "tac", "displayName": "Tac", "active": false
    })];
    if let Ok(rd) = std::fs::read_dir(skins_dir()) {
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() { continue; }
            let mf_path = path.join("manifest.json");
            if !mf_path.exists() { continue; }
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let display_name = std::fs::read_to_string(&mf_path).ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|v| v.get("displayName").and_then(|d| d.as_str()).map(|s| s.to_string()))
                .unwrap_or_else(|| name.clone());
            skins.push(serde_json::json!({ "name": name, "displayName": display_name, "active": false }));
        }
    }
    let current = read_config_json().get("skin").and_then(|v| v.as_str()).unwrap_or("tac").to_string();
    for s in skins.iter_mut() {
        let is_active = s.get("name").and_then(|v| v.as_str()) == Some(&current);
        if let Some(obj) = s.as_object_mut() { obj.insert("active".into(), serde_json::Value::Bool(is_active)); }
    }
    serde_json::json!({ "skins": skins })
}

// ---------- Commands: data ----------

#[tauri::command]
fn get_sessions() -> serde_json::Value { build_sessions_payload() }

#[tauri::command]
fn get_skins() -> serde_json::Value { build_skins_payload() }

#[tauri::command]
fn get_config() -> serde_json::Value { read_config_json() }

#[tauri::command]
fn get_pet_name() -> String {
    let cfg = read_config_json();
    cfg.get("pet_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_else(|| "master".to_string())
}

// Delete an installed skin. Guards: built-in "tac" is undeletable, and the
// name must be a plain slug (no path tricks). If the deleted skin was
// active, fall back to "tac".
#[tauri::command]
fn delete_skin(name: String) -> Result<serde_json::Value, String> {
    if name == "tac" { return Err("built-in skin cannot be deleted".into()); }
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("bad skin name: {}", name));
    }
    let dir = skins_dir().join(&name);
    if !dir.is_dir() { return Err(format!("skin not found: {}", name)); }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cfg = read_config_json();
    let was_active = cfg.get("skin").and_then(|v| v.as_str()) == Some(name.as_str());
    if was_active {
        if let Some(obj) = cfg.as_object_mut() {
            obj.insert("skin".into(), serde_json::Value::String("tac".into()));
        }
        write_config_json(&cfg)?;
    }
    Ok(build_skins_payload())
}

#[tauri::command]
fn set_skin(name: String) -> Result<serde_json::Value, String> {
    let mut cfg = read_config_json();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("skin".into(), serde_json::Value::String(name.clone()));
    }
    write_config_json(&cfg)?;
    Ok(build_skins_payload())
}

#[tauri::command]
fn decide(sid: String, behavior: String) -> Result<(), String> {
    if behavior != "allow" && behavior != "deny" {
        return Err(format!("bad behavior: {}", behavior));
    }
    std::fs::create_dir_all(decisions_dir()).map_err(|e| e.to_string())?;
    let path = decisions_dir().join(format!("{}.json", sid));
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let payload = serde_json::json!({ "behavior": behavior, "ts": ts });
    std::fs::write(path, payload.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_skin_asset(skin: String, file: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let path = skins_dir().join(&skin).join(&file);
    let data = std::fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let b64 = STANDARD.encode(&data);
    let mime = if file.ends_with(".gif") { "image/gif" }
               else if file.ends_with(".png") { "image/png" }
               else if file.ends_with(".webp") { "image/webp" }
               else { "application/octet-stream" };
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
fn get_skin_manifest(name: String) -> Result<serde_json::Value, String> {
    let path = skins_dir().join(&name).join("manifest.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

// ---------- Transcript tail (expanded session log) ----------
#[tauri::command]
fn get_transcript_tail(path: String, n: usize) -> Vec<serde_json::Value> {
    use std::io::{Read, Seek, SeekFrom};
    let mut out: Vec<serde_json::Value> = Vec::new();
    let Ok(mut f) = std::fs::File::open(&path) else { return out };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = size.saturating_sub(512 * 1024);
    if f.seek(SeekFrom::Start(start)).is_err() { return out; }
    let mut buf = String::new();
    if f.read_to_string(&mut buf).is_err() { return out; }

    let mut results: Vec<serde_json::Value> = Vec::new();
    for line in buf.lines() {
        let Ok(d) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let t = d.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if t != "user" && t != "assistant" { continue; }
        let Some(msg) = d.get("message") else { continue };
        let content = msg.get("content");
        if let Some(parts) = content.and_then(|c| c.as_array()) {
            for part in parts {
                if part.get("type").and_then(|v| v.as_str()) == Some("tool_use") {
                    let name = part.get("name").and_then(|v| v.as_str()).unwrap_or("tool");
                    results.push(serde_json::json!({ "kind": "tool", "text": name }));
                }
            }
        }
        let text = match content {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => parts.iter()
                .find_map(|p| {
                    if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                        p.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
                    } else { None }
                }).unwrap_or_default(),
            _ => String::new(),
        };
        let trimmed = text.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('<') && !trimmed.starts_with('[') {
            let short: String = trimmed.chars().take(80).collect();
            results.push(serde_json::json!({ "kind": t, "text": short }));
        }
    }
    let keep = results.len().saturating_sub(n);
    out.extend(results.into_iter().skip(keep));
    out
}

#[tauri::command]
fn get_last_assistant_message(path: String) -> Option<String> {
    last_assistant_text(&path)
}

// ---------- Skin installer (port of Hammerspoon installSkinFromZip) ----------
fn slugify(s: &str) -> String {
    let mut out: String = s.to_lowercase().chars()
        .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    while out.contains("--") { out = out.replace("--", "-"); }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "skin".into() } else { out }
}

fn title_case(s: &str) -> String {
    s.split(|c: char| c == '-' || c == '_' || c == ' ')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>().join(" ")
}

#[tauri::command]
fn install_skin_zip(zip_path: String) -> Result<serde_json::Value, String> {
    let tmp = std::env::temp_dir().join(format!("companion-skin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("/usr/bin/unzip")
        .args(["-q", "-o", &zip_path, "-d"])
        .arg(&tmp)
        .status().map_err(|e| e.to_string())?;
    if !status.success() { return Err("unzip failed".into()); }

    let mut root = tmp.clone();
    let entries: Vec<_> = std::fs::read_dir(&root).map_err(|e| e.to_string())?
        .flatten().collect();
    if entries.len() == 1 && entries[0].path().is_dir() {
        root = entries[0].path();
    }

    let mut gifs: Vec<String> = Vec::new();
    let mut spritesheet: Option<String> = None;
    let mut pet_json: Option<serde_json::Value> = None;
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let lower = fname.to_lowercase();
        if lower.ends_with(".gif") { gifs.push(fname); }
        else if lower.ends_with(".webp") || lower.ends_with(".png") {
            if spritesheet.is_none() || lower.contains("sprite") { spritesheet = Some(fname); }
        } else if lower == "pet.json" {
            pet_json = std::fs::read_to_string(&p).ok()
                .and_then(|s| serde_json::from_str(&s).ok());
        }
    }
    gifs.sort();

    let (slug, display) = if let Some(pj) = &pet_json {
        let id = pj.get("id").and_then(|v| v.as_str()).unwrap_or("skin");
        let dn = pj.get("displayName").and_then(|v| v.as_str()).unwrap_or(id).to_string();
        (slugify(id), dn)
    } else if !gifs.is_empty() {
        let names: Vec<String> = gifs.iter().map(|g| g.trim_end_matches(".gif").to_string()).collect();
        let mut prefix = names[0].clone();
        for n in &names[1..] {
            while !n.starts_with(&prefix) && !prefix.is_empty() { prefix.pop(); }
        }
        let prefix = prefix.trim_end_matches('-').to_string();
        if prefix.is_empty() {
            let base = std::path::Path::new(&zip_path).file_stem()
                .and_then(|s| s.to_str()).unwrap_or("skin")
                .trim_end_matches("-gifs").to_string();
            (slugify(&base), title_case(&base))
        } else {
            (slugify(&prefix), title_case(&prefix))
        }
    } else {
        return Err("zip has neither GIFs nor a sprite sheet".into());
    };

    let mut manifest = serde_json::json!({
        "displayName": display,
        "attribution": "Installed via Companion",
        "display": { "w": 108, "h": 116 },
        "bubbleOffset": 44,
    });
    if !gifs.is_empty() {
        let pick = |kw: &str| gifs.iter().find(|g| g.to_lowercase().contains(kw)).cloned();
        let running = pick("running.gif").or_else(|| pick("running-right")).or_else(|| pick("run"))
            .unwrap_or_else(|| gifs[0].clone());
        let jumping = pick("jumping").or_else(|| pick("waving")).unwrap_or_else(|| running.clone());
        let mut gm = serde_json::json!({ "input": running, "done": jumping });
        if let Some(g) = pick("idle")    { gm["idle"] = serde_json::Value::String(g); }
        if let Some(g) = pick("waiting") { gm["waiting"] = serde_json::Value::String(g); }
        if let Some(g) = pick("review")  { gm["review"] = serde_json::Value::String(g); }
        if let Some(g) = pick("failed")  { gm["failed"] = serde_json::Value::String(g); }
        manifest["gifs"] = gm;
    } else if let Some(sheet) = &spritesheet {
        manifest["spritesheet"] = serde_json::Value::String(sheet.clone());
        manifest["sheet"] = serde_json::json!({ "w": 1536, "h": 1872 });
        manifest["frame"] = serde_json::json!({ "w": 192, "h": 208 });
        manifest["animations"] = serde_json::json!({
            "input": { "row": 1, "col": 0, "count": 8, "duration": 0.7 }
        });
    }

    let dst = skins_dir().join(&slug);
    let _ = std::fs::remove_dir_all(&dst);
    std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if !p.is_file() { continue; }
        let fname = p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        let is_sheet = spritesheet.as_ref().map(|s| s.to_lowercase()) == Some(fname.clone());
        if fname.ends_with(".gif") || is_sheet {
            let dest = dst.join(p.file_name().unwrap());
            std::fs::copy(&p, &dest).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(dst.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(serde_json::json!({ "slug": slug, "displayName": manifest["displayName"] }))
}

// ---------- Window control ----------

#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_window(window: tauri::WebviewWindow, width: f64, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;
    let current_size = window.outer_size().map_err(|e| e.to_string())?;
    let cur_logical_h = current_size.height as f64 / scale;
    let cur_logical_y = current_pos.y as f64 / scale;
    let cur_logical_x = current_pos.x as f64 / scale;
    let bottom = cur_logical_y + cur_logical_h;
    let new_y = bottom - height;
    window.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    window.set_position(LogicalPosition::new(cur_logical_x, new_y)).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn start_drag(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_pet_position(x: f64, y_bottom: f64) -> Result<(), String> {
    let mut cfg = read_config_json();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("tauri_pet_x".into(), serde_json::Value::from(x));
        obj.insert("tauri_pet_y_bottom".into(), serde_json::Value::from(y_bottom));
    }
    write_config_json(&cfg)
}

#[tauri::command]
fn mark_autostart_prompted() -> Result<(), String> {
    let mut cfg = read_config_json();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("autostart_prompted".into(), serde_json::Value::Bool(true));
    }
    write_config_json(&cfg)
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) { app.exit(0); }

// ---------- Setup ----------

fn start_status_watcher(app: tauri::AppHandle) -> Option<RecommendedWatcher> {
    let dir = menubar_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let app_for_watcher = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let is_status = event.paths.iter().any(|p|
                p.file_name().and_then(|n| n.to_str()) == Some("status.json"));
            if !is_status { return; }
            push_sessions(&app_for_watcher);
        }
    }).ok()?;
    watcher.watch(&dir, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .manage(AppState { _watcher: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            get_sessions, get_skins, get_config, get_pet_name,
            set_skin, delete_skin, decide, get_skin_asset, get_skin_manifest,
            get_transcript_tail, get_last_assistant_message, install_skin_zip,
            set_click_through, resize_window, start_drag,
            save_pet_position, mark_autostart_prompted, quit_app,
        ])
        .setup(|app| {
            // Menubar tray: "cc" title, click toggles the panel via JS.
            let _tray = TrayIconBuilder::with_id("cc")
                .title("cc")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let _ = tray.app_handle().emit("tray-click", ());
                    }
                })
                .build(app)?;

            // Restore saved position, else bottom-right corner.
            let cfg = read_config_json();
            let saved_x = cfg.get("tauri_pet_x").and_then(|v| v.as_f64());
            let saved_yb = cfg.get("tauri_pet_y_bottom").and_then(|v| v.as_f64());
            if let Some(window) = app.get_webview_window("companion") {
                if let (Some(x), Some(yb)) = (saved_x, saved_yb) {
                    let _ = window.set_position(LogicalPosition::new(x, yb - 220.0));
                } else if let Some(monitor) = window.primary_monitor().ok().flatten() {
                    let msize = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = msize.width as f64 / scale;
                    let logical_h = msize.height as f64 / scale;
                    let target_x = logical_w - 380.0 - 28.0;
                    let target_y = logical_h - 220.0 - 28.0;
                    let _ = window.set_position(PhysicalPosition::new(
                        (target_x * scale) as i32, (target_y * scale) as i32));
                }
            }

            // Initial push + skins
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(500));
                push_sessions(&app_handle);
                let _ = app_handle.emit("skins", build_skins_payload());
            });

            // File watcher + 3s polling safety net
            let watcher_handle = start_status_watcher(app.handle().clone());
            if let Some(w) = watcher_handle {
                let state: State<AppState> = app.state();
                *state._watcher.lock().unwrap() = Some(w);
            }
            let app_poll = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(3));
                    push_sessions(&app_poll);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
