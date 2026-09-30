# ============================================================
# publish-window.ps1 —— npm 发布窗口（一键到底，不需要 y/n）
#
# 流程：预检 -> 门禁 -> 发布演练 -> 真发布(2FA) -> 发布后校验
#   全程没有确认门：任何前置条件不满足就自己停下并说明原因；
#   人只需要做一件事——npm 要一次性验证码时，把 6 位码贴进窗口。
#
# 为什么是窗口而不是后台命令（来自 dsh-prompt 的实测经验）：
#   1. npm publish 的 2FA 审批要【真实 TTY + 用户本人】：后台环境直接跑会 EOTP，
#      隔空传验证码必过期。
#   2. Agent 直接 Start-Process 开的窗口落在用户看不见的会话——要用 schtasks 交互式
#      任务（/IT）把窗口启动到用户交互桌面。
#   3. Windows PowerShell 5.1 读没有 BOM 的 .ps1 会按 ANSI 解析、Get-Content 默认也按
#      ANSI 读 —— 所以本脚本存 UTF-8(BOM)，读 package.json 显式 -Encoding UTF8。
#   4. 结果落盘：整窗转录 + 状态 JSON（权威判据），Agent 读文件，不必等用户复述。
#
# 用法：
#   用户：双击 publish.cmd
#   Agent：schtasks /create /tn "DSHPublishUpdate" /tr "cmd.exe /c <仓根>\publish.cmd"
#            /sc once /st 23:59 /it /f   然后 schtasks /run /tn "DSHPublishUpdate"
#
# 参数：
#   -PackageDir   待发布 npm 包目录（必填）
#   -Preview      只跑到发布演练为止，不执行 npm publish
#   -AllowDirty   工作区有未提交改动也照样发（默认：有改动就停）
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [switch]$Preview,
    [switch]$AllowDirty
)

$Host.UI.RawUI.WindowTitle = 'DSH npm publish - dsh-plugin-update'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Npmjs = 'https://registry.npmjs.org'
$PublishLog = Join-Path $PackageDir ('.tmp-publish-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$PublishStatus = Join-Path $PackageDir '.tmp-publish-status.json'
$PublishExit = 1

function Say($text) { Write-Host $text }
function Fail($why) {
    Write-Host ''
    Write-Host ('  ✗ ' + $why)
    Write-Host '  停在这里，什么都没发。修好后重新双击 publish.cmd 即可。'
}

# 每次发布留一份转录，攒多了自己清理：只留最近 5 份。
try {
    Get-ChildItem (Join-Path $PackageDir '.tmp-publish-*.log') -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 5 |
        Remove-Item -Force -ErrorAction SilentlyContinue
} catch { }

try {
    Remove-Item $PublishStatus -Force -ErrorAction SilentlyContinue
    Start-Transcript -Path $PublishLog -Force | Out-Null
} catch {
    Say ('（转录没开起来，不影响发布：' + $_.Exception.Message + '）')
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  dsh-plugin-update 发布窗口（一键到底，不需要 y/n）'
Write-Host '============================================================'
Write-Host '  预检 -> 门禁 -> 发布演练 -> 真发布(2FA) -> 发布后校验'
Write-Host '  全程只有一处要你动手：npm 要一次性验证码时，把 6 位码贴进来。'
Write-Host '============================================================'
Write-Host ''
Say ('发布目录: ' + $PackageDir)

Set-Location -Path $PackageDir

$PkgName = 'unknown'
$Version = 'unknown'
try {
    # 必须显式 -Encoding UTF8：PS 5.1 的 Get-Content 默认按 ANSI(GBK) 读，
    # 我们的 package.json 是 UTF-8 无 BOM，不写编码会读成乱码、连 JSON 都解析不了。
    $PkgJson = Get-Content (Join-Path $PackageDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $PkgName = $PkgJson.name
    $Version = $PkgJson.version
} catch {
    Say ('读 package.json 失败：' + $_.Exception.Message)
}

:main while ($true) {

    if ($PkgName -eq 'unknown' -or $Version -eq 'unknown') {
        Fail '读不出 package.json 的包名/版本号。'
        break main
    }

    # ── 1. 预检（不满足就停，不问） ───────────────────────────────────────
    Write-Host ''
    Write-Host ('  ▸ 1/5 预检 · ' + $PkgName + '@' + $Version)
    Say ('  HEAD: ' + (& git log --oneline -1))

    $dirty = ((& git status --porcelain --untracked-files=no) -join "`n")
    if ($dirty.Trim().Length -gt 0) {
        if (-not $AllowDirty) {
            Write-Host '  未提交的改动：'
            Write-Host $dirty
            Fail '工作区有未提交的改动（要照样发就加 -AllowDirty）。'
            break main
        }
        Say '  ⚠ 工作区有未提交改动，-AllowDirty 放行'
    } else {
        Say '  工作区干净（已跟踪文件无改动）✓'
    }

    $whoami = (& npm whoami --registry=$Npmjs 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $whoami) {
        Write-Host '  没登录 npmjs，转网页登录（浏览器里完成 2FA，自动继续）...'
        & npm login --auth-type=web --registry=$Npmjs
        $whoami = (& npm whoami --registry=$Npmjs 2>$null | Out-String).Trim()
        if (-not $whoami) { Fail '还是没登录上 npmjs。'; break main }
    }
    Say ('  npmjs 身份：' + $whoami + ' ✓')

    & npm view ($PkgName + '@' + $Version) version --registry=$Npmjs --prefer-online 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Fail ($PkgName + '@' + $Version + ' 在 npmjs 上已经存在——先改 package.json 的版本号。')
        break main
    }
    Say ('  npmjs 上还没有 ' + $Version + '，可以发 ✓')

    # ── 2. 门禁 ───────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 2/5 构建与门禁 · npm test（pretest 会先 build）'
    if ($Preview) {
        Say '  [预览] 跳过 npm test'
    } else {
        & npm test
        if ($LASTEXITCODE -ne 0) { Fail '门禁没过（上面有红的）。'; break main }
        Say '  全绿 ✓'
    }

    # ── 3. 发布演练 ───────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 3/5 发布演练 · npm publish --dry-run（不发东西）'
    & npm publish --dry-run --registry=$Npmjs
    if ($LASTEXITCODE -ne 0) { Fail '演练失败（上面有报错）。'; break main }
    Say '  清单应只有：dist(9 个 JS) + derive-client-values.mjs + event-list.template.json + README.md + LICENSE + package.json。'

    if ($Preview) {
        Say '  [预览] 到此为止，没有执行 npm publish。'
        $PublishExit = 0
        break main
    }

    # ── 4. 真发布（唯一需要动手的地方就在这一段） ─────────────────────────
    Write-Host ''
    Write-Host '  ▸ 4/5 真发布 · npm publish（不可撤销）'
    & npm publish --registry=$Npmjs
    $PublishExit = $LASTEXITCODE
    if ($PublishExit -ne 0) {
        Write-Host '  需要一次性验证码（EOTP）。'
        $otp = Read-Host '  粘贴 authenticator 里的 6 位码（直接回车=放弃）'
        if ($otp.Trim().Length -gt 0) {
            & npm publish --registry=$Npmjs --otp=$otp
            $PublishExit = $LASTEXITCODE
        }
    }
    # 记下这次 publish 的 npm 调试日志：发布那一次的最有用，落进状态文件，事后不必靠窗口复述。
    $PublishDebugLog = ''
    try {
        $dbg = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'npm-cache\_logs\*-debug-0.log') -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($dbg) { $PublishDebugLog = $dbg.FullName }
    } catch { }
    if ($PublishExit -ne 0 -and $PublishDebugLog) { Say ('  npm 调试日志: ' + $PublishDebugLog) }

    # ── 5. 发布后校验 ─────────────────────────────────────────────────────
    # npm 回 202 / exit 0 只代表「已受理」：registry 上架可能滞后几分钟（npm 自己会打印
    # 「may take a few minutes to become available」）。所以这里必须轮询，不能立刻下结论。
    # 轮询走 registry 的 HTTP GET，**不走 npm view**：npm 每跑一次写一份调试日志、只留最近
    # 10 份（logs-max=10），高频 npm view 会把发布那一次的日志挤掉（0.2.0 发布时踩过）。
    Write-Host ''
    Write-Host '  ▸ 5/5 发布后校验'
    $Visible = $false
    if ($PublishExit -eq 0) {
        Say ('  npm 已受理 ' + $PkgName + '@' + $Version + '；最多等 15 分钟，每 15 秒问一次 registry...')
        $deadline = (Get-Date).AddMinutes(15)
        $waited = 0
        while ((Get-Date) -lt $deadline) {
            $doc = $null
            try {
                $doc = Invoke-RestMethod ('https://registry.npmjs.org/' + $PkgName) -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 20
            } catch { $doc = $null }
            if ($doc -and ($doc.versions.PSObject.Properties.Name -contains $Version)) { $Visible = $true; break }
            Start-Sleep -Seconds 15
            $waited += 15
            Write-Host ('    ...' + $waited + ' 秒，还没生效')
        }
        if ($Visible) {
            Say ('  registry 上已经有了 ✓（等了约 ' + $waited + ' 秒）')
        } else {
            Write-Host '  ⚠ 15 分钟还没生效：npm 已受理但尚未落地。两个选择：'
            Write-Host '     ① 过几分钟再查一次：npm view ' + $PkgName + '@' + $Version + ' version --registry=' + $Npmjs)
            Write-Host '     ② 重新双击 publish.cmd 重发一次（同版本重发是安全的：真已存在会报 E409，不会重复上架）'
        }
    }

    if ($PublishExit -eq 0 -and $Visible) {
        $latest = (& npm view $PkgName version --registry=$Npmjs 2>$null | Out-String).Trim()
        Say ('  npmjs latest = ' + $latest + '（本包版本 ' + $Version + '）')
        & npm view ($PkgName + '@' + $Version) dist.tarball dist.integrity --registry=$Npmjs
        $smoke = Join-Path $env:TEMP ('dsh-update-smoke-' + (Get-Date -Format 'HHmmss'))
        try {
            New-Item -ItemType Directory -Path $smoke -Force | Out-Null
            Push-Location $smoke
            & npm init -y | Out-Null
            & npm install --registry=$Npmjs ($PkgName + '@' + $Version) | Out-Null
            if ($LASTEXITCODE -eq 0) {
                & node -e ("import('" + $PkgName + "').then(m => { if (typeof m.createHostUpdate !== 'function') process.exit(1); console.log('  createHostUpdate ✓'); })")
                if ($LASTEXITCODE -eq 0) { Say '  临时目录真装一次、导得出 ✓' } else { Write-Host '  ⚠ 装上但导入失败，去 npmjs 页面看一眼' }
            } else {
                Write-Host '  ⚠ 临时目录装不上，去 npmjs 页面看一眼'
            }
        } catch {
            Write-Host ('  ⚠ 冒烟测试没跑成：' + $_.Exception.Message)
        } finally {
            Pop-Location
            Remove-Item $smoke -Recurse -Force -ErrorAction SilentlyContinue
        }
    } elseif ($PublishExit -eq 0) {
        Write-Host '  npm 已受理，但 registry 上还没看到——别急着宣布成功，过几分钟再查一次。'
    } else {
        Write-Host '  发布没成功——把本窗口内容告知 Agent。'
    }

    break main
}

Write-Host ''
Write-Host '============================================================'
Write-Host ('  发布流程结束，退出码: ' + $PublishExit)
if ($PublishExit -eq 0 -and $Visible) {
    Write-Host '  成功：registry 上已经有这一版'
} elseif ($PublishExit -eq 0) {
    Write-Host '  已受理但未确认：npm 收了，registry 还没生效——过几分钟再查'
} else {
    Write-Host '  未成功：把本窗口内容告知 Agent'
}
Write-Host '============================================================'

# 权威判据落盘：Agent 读这一份，不必等用户复述。
try {
    $status = [ordered]@{
        exitCode = $PublishExit
        package  = $PkgName
        version  = $Version
        dir      = $PackageDir
        log      = $PublishLog
        preview  = [bool]$Preview
        visible  = [bool]$Visible
        debugLog = $PublishDebugLog
        at       = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    } | ConvertTo-Json
    Set-Content -Path $PublishStatus -Value $status -Encoding UTF8
    Say ('状态文件: ' + $PublishStatus)
} catch {
    Say ('（状态文件没写成：' + $_.Exception.Message + '）')
}
try { Stop-Transcript | Out-Null } catch { }

exit $PublishExit
