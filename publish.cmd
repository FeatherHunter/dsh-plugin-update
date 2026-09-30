@echo off
rem 双击这个文件即可发布 dsh-plugin-update（真正的发布脚本在 scripts\publish-window.ps1）。
rem 窗口会依次走：预检 → 门禁 → 发布演练 → 真发布（2FA）→ 发布后校验。
start "DSH npm publish" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-window.ps1" -PackageDir "%~dp0"
