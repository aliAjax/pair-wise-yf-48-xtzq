// 多标签页修订号并发场景验证：esbuild 转译 store 后，用双环境模拟两个窗口
import { build } from "esbuild";
import { createPinia, setActivePinia } from "pinia";
import * as vue from "vue";
import { pathToFileURL } from "node:url";

const entryPath = new URL("../src/stores/review.ts", import.meta.url).pathname;
const outPath = new URL("./_store.build.mjs", import.meta.url).pathname;
const vuePath = new URL("../node_modules/vue/index.mjs", import.meta.url).pathname;
const piniaPath = new URL("../node_modules/pinia/dist/pinia.mjs", import.meta.url).pathname;
await build({
  entryPoints: [entryPath],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outPath,
  alias: { vue: vuePath, pinia: piniaPath },
  logLevel: "silent"
});

// ---- 极简浏览器环境桩（所有窗口共享一份存储和监听总线，模拟同源多标签页） ----
function createWindowEnv(shared, name) {
  const env = {
    name,
    addEventListener: (_type, fn) => {
      const wrapper = (ev) => {
        try { if (globalThis.__debugStorage) console.log(`  [evt -> ${name}]`); fn(ev); }
        catch (e) { console.error(`STORAGE HANDLER ERROR in ${name}:`, e); }
      };
      shared.listeners.add(wrapper);
      return () => shared.listeners.delete(wrapper);
    },
    localStorage: {
      getItem: (key) => (shared.storage.has(key) ? shared.storage.get(key) : null),
      setItem: (key, value) => {
        const oldValue = shared.storage.has(key) ? shared.storage.get(key) : null;
        shared.storage.set(key, String(value));
        if (globalThis.__debugStorage) console.log(`  [set by ${name}]`);
        // 浏览器只向"其他"窗口派发 storage 事件，源窗口不收
        shared.listeners.forEach((fn) => fn({ key, oldValue, newValue: String(value) }));
      }
    }
  };
  return env;
}

const shared = { storage: new Map(), listeners: new Set(), envs: [] };
shared.envs.push(createWindowEnv(shared, "A"), createWindowEnv(shared, "B"));
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => Math.random().toString(36).slice(2) + Date.now().toString(36) }, configurable: true });
}

async function loadStore(envIndex, viewer, name = `ENV${envIndex}`) {
  const env = shared.envs[envIndex];
  globalThis.window = env;
  globalThis.localStorage = env.localStorage;
  const pinia = createPinia();
  setActivePinia(pinia);
  const mod = await import(pathToFileURL(outPath).href + `?t=${Date.now()}-${envIndex}-${Math.random()}`);
  const store = mod.useReviewStore(pinia);
  store.setViewer(viewer);
  return store;
}

const values = (n) => ({ site: n, program: n, structure: n, sustain: n });
let pass = 0, fail = 0;
function check(name, condition, detail = "") {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}
const mkBase = (revision, weightVersion, v = 60, comment = "") => ({ revision, updatedAt: "", values: values(v), comment, conflict: false, weightVersion });
const mkPayload = (v, weightVersion, comment = "意见内容长度足够", conflict = false) => ({ values: values(v), comment, conflict, weightVersion });

// ========== 场景 1：两个评委窗口先后保存同一方案，旧修订号被拦下，确认后覆盖 ==========
{
  console.log("场景1：同评委双窗口保存冲突");
  const a = await loadStore(0, "评委-林策");
  const b = await loadStore(1, "评委-林策");

  const r1 = a.saveDraft("a", mkBase(0, 1, 60, ""), mkPayload(70, 1, "A窗口第一版意见内容"));
  check("A 首次保存成功，修订号=1", r1.ok && r1.revision === 1, JSON.stringify(r1));

  await Promise.resolve();
  const bRecord = b.record("a");
  check("B 通过 storage 事件收到 A 的保存（修订号1）", bRecord && bRecord.revision === 1, `实际 ${bRecord?.revision}`);
  const baseB = { revision: bRecord.revision, updatedAt: bRecord.updatedAt, values: { ...bRecord.values }, comment: bRecord.comment, conflict: bRecord.conflict, weightVersion: bRecord.weightVersion };

  const r2 = b.saveDraft("a", baseB, mkPayload(80, 1, "B窗口第二版意见内容"));
  check("B 基于修订号1保存成功，修订号=2", r2.ok && r2.revision === 2, JSON.stringify(r2));

  const r3 = a.saveDraft("a", { ...mkBase(1, 1, 70, "A窗口第一版意见内容"), updatedAt: r1 ? "" : "" }, mkPayload(50, 1, "A窗口旧修订号覆盖"));
  check("A 用旧修订号保存被拦下（conflict）", !r3.ok && r3.reason === "conflict", JSON.stringify(r3));
  check("冲突快照含最新值（B的80分）", r3.conflict?.latest.values.site === 80);
  check("冲突时存储未被污染（仍是B的版本）", a.record("a").values.site === 80);

  const r4 = a.saveDraft("a", { ...r3.conflict.latest }, mkPayload(55, 1, "A确认覆盖后的内容"), true);
  check("A 确认后覆盖写回，修订号=3", r4.ok && r4.revision === 3, JSON.stringify(r4));
  check("覆盖后内容为A的55分", a.record("a").values.site === 55 && a.record("a").comment === "A确认覆盖后的内容");

  // 提交同样走冲突拦截
  const r5 = b.submit("a", { ...baseB, revision: 2 }, mkPayload(90, 1, "B没刷新直接提交"));
  check("B 用旧修订号提交也被拦下", !r5.ok && r5.reason === "conflict");
}

// ========== 场景 2：换权重 → 草稿作废、旧窗口提交被拒、旧定稿退回 ==========
{
  console.log("场景2：权重换版");
  shared.storage.clear();
  shared.envs.push(createWindowEnv(shared, "C")); // 新增第三个窗口给周筑
  const judge = await loadStore(0, "评委-周筑");
  const organizer = await loadStore(1, "主办方");

  judge.saveDraft("a", mkBase(0, 1), mkPayload(70, 1, "还在斟酌的草稿"));
  check("草稿保存后修订号=1", judge.record("a").revision === 1);

  const w = organizer.updateWeights({ site: 40, program: 20, structure: 20, sustain: 20 });
  check("主办方换权重成功，版本升至2", w.ok && w.version === 2, JSON.stringify(w));
  check("换权重时未提交草稿被作废删除", w.staleDrafts === 1, `实际 ${w.staleDrafts}`);
  check("评委窗口权重版本同步到2", judge.weightVersion === 2);
  check("评委本地未提交草稿同步作废", judge.record("a") === null);

  const stale = judge.submit("a", mkBase(1, 1, 70, "旧权重"), mkPayload(70, 1, "旧权重提交"));
  check("旧权重版本提交被拒（weight-stale）", !stale.ok && stale.reason === "weight-stale" && stale.latestWeightVersion === 2, JSON.stringify(stale));

  // 旧版本定稿在换版后保留 submitted 审计痕迹但带旧版本号，锁定门槛自然拦住；重交时才退回
  shared.storage.clear();
  const j1 = await loadStore(0, "评委-林策");
  const org2 = await loadStore(1, "主办方");
  j1.submit("a", mkBase(0, 1), mkPayload(70, 1, "林策v1定稿意见"));
  check("林策 v1 定稿已提交", j1.record("a").submitted === true);
  org2.updateWeights({ site: 35, program: 25, structure: 20, sustain: 20 });
  check("v1 定稿保留 submitted 痕迹", j1.record("a").submitted === true);
  check("但带旧版本号，锁定不认可", !org2.allSubmittedOnCurrentWeights("a"));
  check("旧版本定稿计数=1", org2.staleSubmittedCount === 1);
  const stale2 = j1.submit("a", mkBase(1, 1, 70, "林策v1定稿意见"), mkPayload(70, 1, "没重算直接提交"), true);
  check("拿旧权重要提交照样拒绝", !stale2.ok && stale2.reason === "weight-stale");
  const staleDraft = j1.saveDraft("a", mkBase(1, 1, 70, "林策v1定稿意见"), mkPayload(70, 1, "旧权重草稿"), true);
  check("旧版本定稿拿旧权重存草稿也拒绝", !staleDraft.ok && staleDraft.reason === "weight-stale");
}

// ========== 场景 3：锁定发布只认最新权重版本 ==========
{
  console.log("场景3：锁定发布只认最新权重");
  shared.storage.clear();
  const j1 = await loadStore(0, "评委-林策");
  const org = await loadStore(1, "主办方");
  const j2 = await loadStore(2, "评委-周筑");

  for (const id of ["a", "b", "c"]) {
    j1.submit(id, mkBase(0, 1), mkPayload(70, 1, `林策${id}的v1意见`));
    j2.submit(id, mkBase(0, 1), mkPayload(72, 1, `周筑${id}的v1意见`));
  }
  check("v1 下全部齐备", org.schemes.every((s) => org.allSubmittedOnCurrentWeights(s.id)));

  org.updateWeights({ site: 35, program: 25, structure: 20, sustain: 20 });
  check("换版后尚无人按v2提交，不能锁定", !org.schemes.every((s) => org.allSubmittedOnCurrentWeights(s.id)));
  org.publish();
  check("锁定被拒绝", org.published === false);

  for (const id of ["a", "b", "c"]) {
    const rec = j2.record(id);
    j2.submit(id, { revision: rec.revision, updatedAt: rec.updatedAt, values: { ...rec.values }, comment: rec.comment, conflict: false, weightVersion: 2 }, mkPayload(75, 2, `周筑${id}按新权重重算`));
  }
  check("仅周筑重交仍不能锁定", !org.schemes.every((s) => org.allSubmittedOnCurrentWeights(s.id)));

  for (const id of ["a", "b", "c"]) {
    const rec = j1.record(id);
    j1.submit(id, { revision: rec.revision, updatedAt: rec.updatedAt, values: { ...rec.values }, comment: rec.comment, conflict: false, weightVersion: 2 }, mkPayload(80, 2, `林策${id}按新权重重算`));
  }
  check("两位评委均按v2提交后可以锁定", org.schemes.every((s) => org.allSubmittedOnCurrentWeights(s.id)));
  org.publish();
  check("锁定发布成功", org.published === true);
  check("排名只统计 v2 的两位评委", org.ranking.length === 3 && org.ranking.every((r) => r.judgeCount === 2));
  const expected = ((80 * 35 + 80 * 25 + 80 * 20 + 80 * 20) / 100 + (75 * 35 + 75 * 25 + 75 * 20 + 75 * 20) / 100) / 2;
  check("排名按 v2 权重加权", Math.abs(org.ranking[0].total - Number(expected.toFixed(2))) < 0.01, `期望 ${expected}，实际 ${org.ranking[0].total}`);
  check("锁定后权重不可再改", org.updateWeights({ site: 50, program: 20, structure: 15, sustain: 15 }).reason === "locked");
  check("锁定后评分不可再改", j1.saveDraft("a", mkBase(99, 2), mkPayload(10, 2), true).reason === "locked");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
