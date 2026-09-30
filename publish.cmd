@echo off
rem Double-click this file to publish dsh-plugin-update.
rem It opens scripts\publish-window.ps1 in a PowerShell window:
rem preflight -> npm test -> publish --dry-run -> npm publish (2FA) -> verify.
rem NOTE "%~dp0." (trailing dot): %~dp0 already ends with a backslash, and a
rem trailing backslash before the closing quote escapes it for PowerShell.
start "DSH npm publish" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-window.ps1" -PackageDir "%~dp0."
