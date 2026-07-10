# Claude Companion — 构建 & 部署

## 依赖
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js

## 构建
```bash
cd Plugin/claude-companion
npm install
npm run tauri build -- --bundles app
```

## 部署到 /Applications(替代旧位置)
```bash
pkill -f "Claude Companion.app/Contents/MacOS" 2>/dev/null; sleep 1
rm -rf "/Applications/Claude Companion.app"
cp -R "src-tauri/target/release/bundle/macos/Claude Companion.app" /Applications/
# 未签名 .app 在 macOS 上要 ad-hoc 签名才能启动
codesign --force --deep -s - "/Applications/Claude Companion.app"
xattr -cr "/Applications/Claude Companion.app"
open "/Applications/Claude Companion.app"
```

**位置说明**:App 必须在 `/Applications/`(标准 macOS 位置),原因:
- 开机自启 (`tauri-plugin-autostart`) 注册的 LaunchAgent 里锁死 .app 路径,如果 App 挪位置自启会失效
- Downloads 目录容易被系统清理
- 分发同事时约定俗成的安装位置
