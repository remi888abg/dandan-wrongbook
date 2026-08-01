/* 端到端模拟：蛋蛋错题本 导出/导入 备份功能测试 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "✅ PASS" : "❌ FAIL") + " | " + name + (detail ? " — " + detail : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exportedBlobs = []; // 捕获导出的备份内容

function makeDom(presetStorage) {
  const dom = new JSDOM(HTML, {
    url: "https://test.local/index.html",
    runScripts: "outside-only", // 先不执行，等我们注入 stub 后手动执行
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // 预置 localStorage（模拟已有数据的设备）
  if (presetStorage) win.localStorage.setItem("cuotiben_v1", presetStorage);
  // stub confirm -> 自动点“确定”；prompt -> 自动输入正确密码（可被测试覆盖）
  win.confirm = () => true;
  win.alert = () => {};
  win.prompt = () => "@123456";
  win.open = () => ({ document: { write() {}, close() {} }, focus() {}, print() {} });
  if (!win.matchMedia) win.matchMedia = () => ({ matches: false, addListener() {}, addEventListener() {} });
  // 捕获导出：URL.createObjectURL 拿到 Blob 内容
  win.URL.createObjectURL = (blob) => {
    exportedBlobs.push(blob);
    return "blob:fake-" + exportedBlobs.length;
  };
  win.URL.revokeObjectURL = () => {};
  // 执行页面内联脚本
  const scripts = HTML.match(/<script>([\s\S]*?)<\/script>/g) || [];
  scripts.forEach((s) => {
    const code = s.replace(/^<script>/, "").replace(/<\/script>$/, "");
    dom.window.eval(code);
  });
  // 触发 DOMContentLoaded 之后的初始化（如果页面用了该事件）
  return dom;
}

function getStore(win) {
  const raw = win.localStorage.getItem("cuotiben_v1");
  return raw ? JSON.parse(raw) : null;
}

async function blobText(blob) {
  if (typeof blob.text === "function") return await blob.text();
  // 兜底：jsdom Blob 内部结构
  return Buffer.concat(blob._buffer ? [blob._buffer] : []).toString("utf8");
}

// 用 File + change 事件模拟用户选择备份文件
async function simulateImport(win, jsonStr, mode) {
  const doc = win.document;
  // 点击对应导入按钮，设置 pendingImportMode（会触发 importInput.click，无副作用）
  doc.getElementById(mode === "replace" ? "bkImportReplace" : "bkImportMerge").click();
  const input = doc.getElementById("importInput");
  const file = new win.File([jsonStr], "backup.json", { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new win.Event("change"));
  await sleep(150); // FileReader 异步
}

(async () => {
  console.log("=== 测试 1：全新设备首次打开（种子数据）+ 导出备份 ===");
  const domA = makeDom(null);
  const winA = domA.window;
  await sleep(50);
  const storeA = getStore(winA);
  const seedCount = storeA ? storeA.items.length : 0;
  report("首次打开自动生成示例错题", seedCount === 7, "共 " + seedCount + " 条");

  // 点 ⤓ → 跳设置页签（需操作密码 @123456，prompt stub 自动输入）
  winA.document.getElementById("btnMenu").click();
  const panelShown = winA.document.getElementById("viewSettings").style.display === "block";
  report("点击 ⤓ 验密后进入设置页签", panelShown);

  winA.document.getElementById("bkExport").click();
  await sleep(50);
  report("点击导出生成备份文件", exportedBlobs.length === 1);

  const backupJson = await blobText(exportedBlobs[0]);
  let backup;
  try { backup = JSON.parse(backupJson); } catch (e) { backup = null; }
  report("备份文件是合法 JSON", !!backup);
  report("备份包含全部 7 条错题", backup && backup.items.length === 7);
  const sample = backup && backup.items[0];
  const hasFields = sample && "id" in sample && "subject" in sample && "reviewStage" in sample && "mastered" in sample && "tags" in sample;
  report("备份含复习进度字段(reviewStage/mastered/tags)", !!hasFields,
    sample ? "示例: " + sample.subject + " stage=" + sample.reviewStage : "");
  // 记录原始复习进度指纹，供覆盖恢复后比对
  const fingerprint = backup.items.map((it) => it.id + ":" + (it.reviewStage | 0) + ":" + (it.mastered ? 1 : 0)).sort().join("|");
  const toastA = winA.document.getElementById("toast").textContent;
  report("导出后提示 toast", toastA === "已导出备份", "toast=" + toastA);

  console.log("\n=== 测试 2：另一台设备（已有 2 条自己的错题）→ 合并导入 ===");
  const myItems = {
    version: 1,
    items: [
      { id: "mine_001", subject: "物理", question: "自由落体 t=2s 位移?", myAnswer: "10m", correctAnswer: "19.6m", reason: "g 取值错误", knowledge: "自由落体", date: "2026-07-28", difficulty: 3, tags: ["计算错误"], images: [], mastered: false, reviewStage: 0, lastReviewDate: "" },
      { id: "mine_002", subject: "化学", question: "水的摩尔质量?", myAnswer: "16", correctAnswer: "18 g/mol", reason: "漏算氢", knowledge: "摩尔质量", date: "2026-07-28", difficulty: 2, tags: ["概念混淆"], images: [], mastered: false, reviewStage: 1, lastReviewDate: "2026-07-28" },
    ],
  };
  const domB = makeDom(JSON.stringify(myItems));
  const winB = domB.window;
  await sleep(50);
  const storeB0 = getStore(winB);
  report("已有数据设备不注入示例题", storeB0.items.length === 2, storeB0.items.length + " 条");

  await simulateImport(winB, backupJson, "merge");
  const storeB1 = getStore(winB);
  report("合并导入：2 + 7 = 9 条", storeB1.items.length === 9, "实际 " + storeB1.items.length + " 条");
  const toastB = winB.document.getElementById("toast").textContent;
  report("合并 toast 正确", /已合并 7 条/.test(toastB), "toast=" + toastB);

  // 重复导入同一备份 → 全部跳过
  await simulateImport(winB, backupJson, "merge");
  const storeB2 = getStore(winB);
  report("重复导入自动去重（仍 9 条）", storeB2.items.length === 9, "实际 " + storeB2.items.length + " 条");

  console.log("\n=== 测试 3：覆盖恢复（模拟离线版更新后整本还原） ===");
  await simulateImport(winB, backupJson, "replace");
  const storeB3 = getStore(winB);
  report("覆盖恢复后恰好 7 条", storeB3.items.length === 7, "实际 " + storeB3.items.length + " 条");
  const fp2 = storeB3.items.map((it) => it.id + ":" + (it.reviewStage | 0) + ":" + (it.mastered ? 1 : 0)).sort().join("|");
  report("复习进度完整还原(逐条 id/stage/mastered 一致)", fp2 === fingerprint);

  console.log("\n=== 测试 4：容错 —— 导入损坏/错误文件 ===");
  await simulateImport(winB, "{ this is not json !!", "merge");
  const toastBad = winB.document.getElementById("toast").textContent;
  report("坏文件不崩溃且有提示", /格式错误/.test(toastBad), "toast=" + toastBad);
  const storeB4 = getStore(winB);
  report("坏文件导入后数据未被破坏", storeB4.items.length === 7);

  await simulateImport(winB, JSON.stringify({ version: 1, items: [] }), "replace");
  const toastEmpty = winB.document.getElementById("toast").textContent;
  report("空备份被拒绝", /没有错题/.test(toastEmpty), "toast=" + toastEmpty);

  console.log("\n=== 测试 5：双密码（登录 180515 / 操作 @123456） ===");
  const domC = makeDom(null);
  const winC = domC.window;
  await sleep(50);
  const lockShown = winC.document.getElementById("lockScreen").classList.contains("show");
  report("首次打开显示密码锁屏", lockShown);

  // 输错登录密码 → 不解锁（旧操作密码 @123456 也不能用于登录）
  winC.document.getElementById("lockInput").value = "@123456";
  winC.document.getElementById("lockBtn").click();
  report("操作密码 @123456 不能用于登录", winC.document.getElementById("lockScreen").classList.contains("show"));

  // 输入正确登录密码 180515 → 解锁
  winC.document.getElementById("lockInput").value = "180515";
  winC.document.getElementById("lockBtn").click();
  report("登录密码 180515 解锁成功", !winC.document.getElementById("lockScreen").classList.contains("show"));
  report("解锁状态写入 sessionStorage", winC.sessionStorage.getItem("cuotiben_unlocked") === "1");

  // 设置页签门禁：错误操作密码进不去
  winC.prompt = () => "wrongpw";
  winC.document.querySelector('.tab[data-tab="settings"]').click();
  report("错误操作密码进不了设置页", winC.document.getElementById("viewSettings").style.display !== "block");
  // 正确操作密码 @123456 → 进入设置页
  winC.prompt = () => "@123456";
  winC.document.querySelector('.tab[data-tab="settings"]').click();
  report("操作密码 @123456 进入设置页", winC.document.getElementById("viewSettings").style.display === "block");

  // 覆盖恢复需要验密：密码错 → 被拦截
  winC.prompt = () => "badpw";
  winC.document.getElementById("bkImportReplace").click();
  const toastPw = winC.document.getElementById("toast").textContent;
  report("覆盖恢复输错密码被拦截", /密码错误/.test(toastPw), "toast=" + toastPw);

  // 密码对 → 放行（走到文件选择这一步即视为放行）
  winC.prompt = () => "@123456";
  await simulateImport(winC, backupJson, "replace");
  const storeC = getStore(winC);
  report("验密通过后覆盖恢复成功", storeC.items.length === 7, "共 " + storeC.items.length + " 条");

  // 清空全部数据（需密码）
  winC.document.getElementById("bkClearAll").click();
  await sleep(30);
  const storeC2 = getStore(winC);
  report("验密后清空全部数据成功", storeC2.items.length === 0, "剩 " + storeC2.items.length + " 条");

  // 修改密码：@123456 -> 8888，然后旧密码失效
  let pwStep = 0;
  winC.prompt = () => { pwStep++; return pwStep === 1 ? "@123456" : "8888"; };
  winC.document.getElementById("bkChangePw").click();
  const toastChg = winC.document.getElementById("toast").textContent;
  report("修改密码成功", /密码已修改/.test(toastChg), "toast=" + toastChg);
  winC.prompt = () => "@123456"; // 旧密码
  winC.document.getElementById("bkImportReplace").click();
  report("改密后旧密码失效", /密码错误/.test(winC.document.getElementById("toast").textContent));

  // 修改登录密码：180515 -> 9999，旧登录密码失效、新密码可解锁
  let lpStep = 0;
  winC.prompt = () => { lpStep++; return lpStep === 1 ? "180515" : "9999"; };
  winC.document.getElementById("bkChangeLoginPw").click();
  report("修改登录密码成功", /登录密码已修改/.test(winC.document.getElementById("toast").textContent));
  const card = winC.document.getElementById("lockCard");
  card.classList.remove("shake");
  winC.document.getElementById("lockInput").value = "180515";
  winC.document.getElementById("lockBtn").click();
  report("改登录密码后旧密码 180515 失效", card.classList.contains("shake"));
  card.classList.remove("shake");
  winC.document.getElementById("lockInput").value = "9999";
  winC.document.getElementById("lockBtn").click();
  report("新登录密码 9999 可解锁", !card.classList.contains("shake"));

  // 汇总
  const fail = results.filter((r) => !r.ok).length;
  console.log("\n========================================");
  console.log("总计 " + results.length + " 项检查，通过 " + (results.length - fail) + "，失败 " + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("测试脚本异常:", e); process.exit(2); });
