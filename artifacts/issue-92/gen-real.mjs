
import { renderUpdatePanelHTML } from "../../dist/panel.js";
const snapshot = {
  runningVersion: "1.7.45",
  installedVersion: "1.7.45",
  latestVersion: "1.7.46",
  canInstall: false,
  blockedReason: "source-install",
  job: null,
};
function page(theme, title) {
  const body = renderUpdatePanelHTML({
    mode: "embedded",
    showOthers: false,
    pluginId: "dsh-mattpocock-skills-deck",
    copyNotice: null,
    lang: "zh",
    theme,
    profileName: "web",
    hostKind: "cli",
    snapshot,
    manual: null,
    queue: null,
    skippedLatest: false,
    lastError: null,
  }, "zh");
  return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>"+title+"</title></head><body style=\"margin:0;padding:24px;font-family:system-ui\">"+body+"</body></html>";
}
import { writeFileSync } from "fs";
writeFileSync("artifacts/issue-92/real-blocked-default.html", page(undefined, "真实渲染·默认主题·source-install"));
writeFileSync("artifacts/issue-92/real-blocked-archive.html", page("archive", "真实渲染·档案卷·source-install"));
console.log("wrote both");
