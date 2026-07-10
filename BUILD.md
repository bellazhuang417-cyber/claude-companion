# Claude Companion — 构建说明

Tauri v2 版的 Claude Code 桌宠 + 会话面板（替代 Hammerspoon 版）。

## 依赖
- Rust（`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`）
- Node.js

## 构建
```bash
npm install
npm run tauri build -- --bundles app
# 产物: src-tauri/target/release/bundle/macos/Claude Companion.app
# 无签名 app 需要 ad-hoc 签名才能在新 macOS 启动:
codesign --force --deep -s - "src-tauri/target/release/bundle/macos/Claude Companion.app"
```

## 数据依赖
读写 `~/.claude-menubar/`（status.json / decisions/ / skins/ / config.json），
hooks 侧由 claude-code-menubar 仓库的 update_status.py 提供（不依赖 Hammerspoon）。
