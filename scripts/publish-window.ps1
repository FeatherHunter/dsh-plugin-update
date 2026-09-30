# ============================================================
# publish-window.ps1 —— npm 发布窗口（Agent 拉起，用户完成 2FA）
#
# 设计理念（来自 dsh-prompt 的实测经验）：
#   1. npm publish 的 2FA 审批要【真实 TTY + 用户本人】：Agent 后台环境直接跑会 EOTP，
#      隔空传 OTP 必过期。
#   2. Agent 直接 Start-Process 开的窗口落在用户看不见的会话——用 schtasks 交互式任务
#      （/IT）把窗口启动到用户交互桌面。
#   3. 系统代码页可能是 65001：本脚本必须 UTF-8(BOM) 保存，脚本内显式设输出编码；
#      脚本路径避免中文。
#   4. 结果落盘：整窗转录 + 状态 JSON（权威判据），Agent 读文件，不必等用户复述。
#
# 用法：
#   用户：双击 publish.cmd
#   Agent：schtasks /create /tn "DSHPublishUpdate" /tr "<powershell.exe> -NoProfile
#            -ExecutionPolicy Bypass -File \"<本脚本>\" -PackageDir \"<包目录>\"" /sc once
#            /st 23:59 /it /f   然后 schtasks /run /tn "DSHPublishUpdate"
#          收尾：schtasks /delete /tn "DSHPublishUpdate" /f
#
# 参数：
#   -PackageDir  待发布 npm 包目录（必填）
#   -Preview     只做预检与演练，不执行 npm publish；不暂停
# ============================================================
param(
    [Parameter(Mandatory = $true)][string]$PackageDir,
    [switch]$Preview
)

$Host.UI.RawUI.WindowTitle = 'DSH npm publish - dsh-plugin-update'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$Npmjs = 'https://registry.npmjs.org'
$PublishLog = Join-Path $PackageDir ('.tmp-publish-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
$PublishStatus = Join-Path $PackageDir '.tmp-publish-status.json'
$PublishExit = 1

function Say($text) { Write-Host $text }
function Gate($prompt) {
    if ($Preview) { return $true }
    $reply = Read-Host ('  ? ' + $prompt + ' [y/N]')
    return ($reply -eq 'y' -or $reply -eq 'Y')
}

try {
    Remove-Item $PublishStatus -Force -ErrorAction SilentlyContinue
    Start-Transcript -Path $PublishLog -Force | Out-Null
} catch {
    Say ('（转录没开起来，不影响发布：' + $_.Exception.Message + '）')
}

Write-Host ''
Write-Host '============================================================'
Write-Host '  dsh-plugin-update 发布窗口'
Write-Host '============================================================'
Write-Host '  流程：预检 -> 门禁 -> 发布演练 -> 真发布(2FA) -> 发布后校验'
Write-Host '  真发布那一步 npm 会要一次性验证码，或让你在浏览器里审批。'
Write-Host '============================================================'
Write-Host ''
Say ('发布目录: ' + $PackageDir)

Set-Location -Path $PackageDir

$PkgName = 'unknown'
$Version = 'unknown'
try {
    # 必须显式 -Encoding UTF8：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 读，
    # 我们的 package.json 是 UTF-8 无 BOM，不写编码会读成乱码、连 JSON 都解析不了。
    $PkgJson = Get-Content (Join-Path $PackageDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $PkgName = $PkgJson.name
    $Version = $PkgJson.version
} catch {
    Say ('读 package.json 失败：' + $_.Exception.Message)
}

:main while ($true) {

    # 读不出元数据就别往下走：版本号是 unknown 时，「npmjs 上有没有这个版本」全是假判断。
    if ($PkgName -eq 'unknown' -or $Version -eq 'unknown') {
        Write-Host '  ⚠ 读不出 package.json 的包名/版本号——停下，先修好再重跑。'
        break main
    }

    # ── 1. 预检 ───────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host ('  ▸ 1/5 预检 · ' + $PkgName + '@' + $Version)
    Say ('  HEAD: ' + (& git log --oneline -1))

    $dirty = ((& git status --porcelain --untracked-files=no) -join "`n")
    if ($dirty.Trim().Length -gt 0) {
        Write-Host '  ⚠ 工作区还有未提交的改动：'
        Write-Host $dirty
        if (-not (Gate '忽略它、继续发布？')) { Say '停下了，什么都没发。'; break main }
    } else {
        Say '  工作区干净（已跟踪文件无改动）✓'
    }

    $whoami = (& npm whoami --registry=$Npmjs 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $whoami) {
        Write-Host '  ⚠ 没登录 npmjs（npm 10 未登录时 publish 直接 ENEEDAUTH）。'
        Say '  接下来走网页登录：浏览器打开授权页 -> 登录 + 2FA -> 自动继续。'
        & npm login --auth-type=web --registry=$Npmjs
        if ($LASTEXITCODE -ne 0) {
            Say '  登录失败——请把本窗口内容完整告知 Agent。'
            break main
        }
        $whoami = (& npm whoami --registry=$Npmjs 2>$null | Out-String).Trim()
    }
    Say ('  npmjs 身份：' + $whoami + ' ✓')

    & npm view ($PkgName + '@' + $Version) version --registry=$Npmjs 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host ('  ⚠ npmjs 上已经有 ' + $PkgName + '@' + $Version + '——先改 package.json 的版本号')
        if (-not (Gate '仍然继续？')) { Say '停下了，什么都没发。'; break main }
    } else {
        Say ('  npmjs 上还没有 ' + $Version + '，可以发 ✓')
    }

    # ── 2. 门禁 ───────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 2/5 构建与门禁 · npm test（pretest 会先 build）'
    if ($Preview) {
        Say '  [预览] 跳过 npm test'
    } else {
        & npm test
        if ($LASTEXITCODE -ne 0) { Say '  门禁没过——先修红的，再重跑本窗口。'; break main }
        Say '  全绿 ✓'
    }

    # ── 3. 发布演练 ───────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 3/5 发布演练 · npm publish --dry-run（不发东西）'
    & npm publish --dry-run --registry=$Npmjs
    if ($LASTEXITCODE -ne 0) { Say '  演练失败——先查上面的报错。'; break main }
    Say '  核对：版本号对不对；清单里只有 dist(9 个 JS) + derive-client-values.mjs + event-list.template.json + README.md + LICENSE + package.json。'
    if (-not (Gate '清单没问题，继续真发布？')) { Say '停下了，什么都没发。'; break main }

    if ($Preview) {
        Say '  [预览] 到此为止，没有执行 npm publish。'
        $PublishExit = 0
        break main
    }

    # ── 4. 真发布 ─────────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 4/5 真发布 · npm publish（不可撤销）'
    & npm publish --registry=$Npmjs
    $PublishExit = $LASTEXITCODE
    if ($PublishExit -ne 0) {
        Write-Host '  上面这条失败了。若提示需要一次性验证码（EOTP）：'
        $otp = Read-Host '  粘贴 authenticator 里的 6 位码（直接回车=放弃）'
        if ($otp.Trim().Length -gt 0) {
            & npm publish --registry=$Npmjs --otp=$otp
            $PublishExit = $LASTEXITCODE
        }
    }

    # ── 5. 发布后校验 ─────────────────────────────────────────────────────
    Write-Host ''
    Write-Host '  ▸ 5/5 发布后校验'
    if ($PublishExit -eq 0) {
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
    } else {
        Write-Host '  发布没成功——请把本窗口内容完整告知 Agent。'
    }

    break main
}

Write-Host ''
Write-Host '============================================================'
Write-Host ('  发布命令已结束，退出码: ' + $PublishExit)
if ($PublishExit -eq 0) {
    Write-Host '  成功标志：上方出现 + <包名>@<版本>，且 npmjs latest 已是新版本'
} else {
    Write-Host '  未成功：把本窗口内容完整告知 Agent'
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
        at       = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    } | ConvertTo-Json
    Set-Content -Path $PublishStatus -Value $status -Encoding UTF8
    Say ('状态文件: ' + $PublishStatus)
} catch {
    Say ('（状态文件没写成：' + $_.Exception.Message + '）')
}
try { Stop-Transcript | Out-Null } catch { }

if (-not $Preview) { Read-Host '按回车关闭窗口' }
exit $PublishExit
