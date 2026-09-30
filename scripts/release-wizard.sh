#!/usr/bin/env bash
#
# 发布向导 —— 一步一步把 dsh-plugin-update 发到 npmjs。
# 由 /wizard 技能生成；照着屏幕走，人工要做的只有：核对、确认、扫码/输验证码。
#
# 跑法（Git Bash；不用先 chmod，直接交给 bash 跑）：
#   & 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /d/dsh-plugin/dsh-plugin-update && bash scripts/release-wizard.sh'
# 或者在 Git Bash 窗口里：
#   cd /d/dsh-plugin/dsh-plugin-update && bash scripts/release-wizard.sh
#
# 前置：Node ≥ 22；npmjs 上已登录（`npm whoami --registry=https://registry.npmjs.org/` 有名字）。
# 注意：本机默认 registry 是镜像（npmmirror），所以每一步都显式写 npmjs。
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — 发布 dsh-plugin-update 到 npmjs
# ──────────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

TOTAL_STAGES=7
NPMJS="https://registry.npmjs.org/"
PKG=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

banner "发布 ${PKG}@${VERSION} 到 npmjs"

# ── 1 ─────────────────────────────────────────────────────────────────────
stage "预检 — 仓库、Node、版本号、npm 身份"
say "发布前先确认四件事，任何一件不对都先停下来。"
printf '  %s\n' "包：${PKG}    版本：${VERSION}    HEAD：$(git log --oneline -1)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  warn "工作区还有未提交的改动（下面这些）——先提交再发布："
  git status --short --untracked-files=no
  confirm "忽略它、继续发布？" || exit 1
else
  note "工作区干净（已跟踪文件无改动）"
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if (( NODE_MAJOR < 22 )); then warn "Node $(node -v) 低于 22，本包要求 ≥ 22"; confirm "继续？" || exit 1; else note "Node $(node -v) ✓"; fi
if npm view "${PKG}@${VERSION}" version --registry="$NPMJS" >/dev/null 2>&1; then
  warn "${PKG}@${VERSION} 在 npmjs 上已经存在——先改 package.json 的版本号"
  confirm "仍然继续？" || exit 1
else
  note "npmjs 上还没有 ${VERSION}，可以发 ✓"
fi
WHO=$(npm whoami --registry="$NPMJS" 2>/dev/null || true)
if [[ -z "$WHO" ]]; then
  warn "npmjs 上没有登录身份。先跑：npm login --registry=$NPMJS --auth-type=web"
  confirm "已经登录好了、继续？" || exit 1
else
  note "npmjs 身份：${WHO} ✓"
fi
pause "预检完，按回车进入构建与门禁"

# ── 2 ─────────────────────────────────────────────────────────────────────
stage "构建与门禁 — 编译 + 全量测试"
say "npm test 的 pretest 会先跑 build（tsc --noEmit + esbuild 转译），再跑全部单测。"
say "这一步必须全绿；红了就别往下走，先把红的修掉。"
npm test
note "构建产物在 dist/（不入库；发布时由 prepack 再构建一次）。"
pause "全绿了，按回车进入发布演练"

# ── 3 ─────────────────────────────────────────────────────────────────────
stage "发布演练 — 看清楚会发什么（不发东西）"
say "dry-run 不碰 npmjs，只把「会进包的文件」列出来。"
npm publish --dry-run --registry="$NPMJS"
step "核对四件事：版本是 ${VERSION}；total files 是 14；清单里只有 dist（9 个 JS）、derive-client-values.mjs、event-list.template.json、README.md、LICENSE、package.json；没有 src/、tests/、docs/。"
step "若文件数不对，先改 package.json 的 files 或补文件，再重跑本向导。"
pause "核对完，按回车进入真发布"

# ── 4 ─────────────────────────────────────────────────────────────────────
stage "真发布 — 到 npmjs（不可撤销）"
say "下面这条会真的把 ${PKG}@${VERSION} 发到 npmjs，发出去就撤不回来了。"
note "npm 会要一次性验证码（2FA）：要么在浏览器里授权，要么把 authenticator 里的 6 位码填进来。"
if confirm "确认发布 ${PKG}@${VERSION} 到 npmjs？"; then
  if npm publish --registry="$NPMJS"; then
    note "已发布 ✓"
  else
    warn "上面这条失败了。两种常见情形："
    step "① 需要一次性验证码（EOTP）：把 authenticator 里的 6 位码填到下面。"
    step "② 提示了一个网址（浏览器授权 / 扫码）：先在浏览器里走完，再回到这里继续。"
    ask_secret OTP "粘贴 6 位一次性验证码（不显示；没有就留空回车）："
    if [[ -z "$OTP" ]]; then
      warn "没有验证码，没发出去。浏览器授权走完后重跑本向导，或手动执行：npm publish --registry=$NPMJS --otp=<码>"
      exit 1
    fi
    npm publish --registry="$NPMJS" --otp="$OTP"
    note "已发布 ✓"
  fi
else
  warn "停下了，什么都没发。"
  exit 1
fi
pause "按回车进入发布后校验"

# ── 5 ─────────────────────────────────────────────────────────────────────
stage "发布后校验 — 真的在 npmjs 上了吗"
say "三件事：npmjs 上的版本号、包地址、以及真装一次能不能 import。"
PUBLISHED=$(npm view "$PKG" version --registry="$NPMJS")
if [[ "$PUBLISHED" == "$VERSION" ]]; then note "npmjs latest = ${PUBLISHED} ✓"; else warn "npmjs latest = ${PUBLISHED}，不是 ${VERSION}——去 npmjs 页面看一眼"; fi
npm view "${PKG}@${VERSION}" dist.tarball dist.integrity --registry="$NPMJS"
say "在临时目录真装一次（干净环境，走 npmjs）："
SMOKE_DIR=$(mktemp -d)
if ( cd "$SMOKE_DIR" && npm init -y >/dev/null 2>&1 \
     && npm install --registry="$NPMJS" "${PKG}@${VERSION}" >/dev/null 2>&1 \
     && node -e "import('${PKG}').then(m => { if (typeof m.createHostUpdate !== 'function') { console.error('createHostUpdate 不在导出里'); process.exit(1) } console.log('  createHostUpdate ✓'); if (typeof m.detectEnvironmentKind !== 'function') process.exit(1); console.log('  detectEnvironmentKind ✓'); })" ); then
  note "装得上、导得出 ✓"
else
  warn "临时目录这次装/导入没成功——去 npmjs 页面对着看，别急着通知消费方"
fi
rm -rf "$SMOKE_DIR"
pause "按回车进入打标签"

# ── 6 ─────────────────────────────────────────────────────────────────────
stage "打标签 — 可选"
note "本仓目前一个 tag 都没有，所以这步纯属你要不要开始立规矩；Enter 就是跳过。"
if confirm "打 ${TAG} 并推到 origin？"; then
  git tag -a "$TAG" -m "发布 ${PKG}@${VERSION}"
  git push origin "$TAG"
  note "已推 ${TAG} ✓"
else
  note "跳过打标签。"
fi
pause "按回车进入交接"

# ── 7 ─────────────────────────────────────────────────────────────────────
stage "交接 — 发布之后还差什么"
say "包已经上了 npmjs，接下来是消费方与现场验收："
step "1. 消费方（dsh-life-pack / ilife）把依赖提到 ^${VERSION}，重新发一版，让新依赖进使用范围。"
step "2. 消费方删掉自己接的那版宿主安装出口——它会挡在本包的路由前面。"
step "3. 现场验收：官方桌面版里查更新 → 点「装上」，并顺手确认第 9 节手工命令到底能不能跑。"
open_url "https://github.com/FeatherHunter/dsh-plugin-update/issues/2"
note "验收单：现场验收：官方桌面端点一次「装上」＋ 确认第 9 节手工兜底命令是否可执行"
pause "按回车收尾"

finish
printf '\n'
note "发布的包：https://www.npmjs.com/package/${PKG}/v/${VERSION}"
printf '\n'
