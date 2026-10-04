import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type {
  Criterion,
  ReviewEvent,
  SaveOutcome,
  Scheme,
  ScorePayload,
  ScoreRecord,
  ScoreSnapshot,
  SubmitOutcome,
  Viewer,
  WeightUpdateOutcome
} from "../types";

const KEY = "pair-wise-yf-48/review";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const seedCriteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];
const START_WEIGHT_VERSION = 1;

/** 旧版本数据（没有修订号字段）迁移：全部按初始权重建档 */
function migrateScore(raw: any): ScoreRecord {
  return {
    ...raw,
    revision: typeof raw.revision === "number" ? raw.revision : 1,
    weightVersion: typeof raw.weightVersion === "number" ? raw.weightVersion : START_WEIGHT_VERSION
  };
}

function emptyScore(judge: Viewer, schemeId: string, weightVersion: number): ScoreRecord {
  return {
    id: `${judge}-${schemeId}`,
    judge,
    schemeId,
    values: Object.fromEntries(seedCriteria.map((item) => [item.id, 60])),
    comment: "",
    submitted: false,
    conflict: false,
    updatedAt: new Date().toISOString(),
    revision: 0,
    weightVersion
  };
}

/** 按修订号合并同一评委同一方案的两条草稿：较新的修订号整体胜出，返回应保留的一条 */
function snapshotOf(item: ScoreRecord): ScoreSnapshot {
  return {
    revision: item.revision,
    updatedAt: item.updatedAt,
    values: { ...item.values },
    comment: item.comment,
    conflict: item.conflict,
    weightVersion: item.weightVersion
  };
}

export const useReviewStore = defineStore("review", () => {
  const saved = localStorage.getItem(KEY);
  const initial = saved
    ? JSON.parse(saved)
    : { scores: [], events: [], published: false, schemeStatuses: {}, weightVersion: START_WEIGHT_VERSION, weights: null, weightUpdatedAt: null };

  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>((initial.scores ?? []).map(migrateScore));
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);

  // 权重及其修订号（版本）。主办方每改一次权重，版本号 +1。
  const weightVersion = ref<number>(initial.weightVersion ?? START_WEIGHT_VERSION);
  const criteria = ref<Criterion[]>((initial.weights ? seedCriteria.map((item) => ({ ...item, weight: initial.weights[item.id] ?? item.weight })) : seedCriteria).map((item) => ({ ...item })));
  const weightUpdatedAt = ref<string | null>(initial.weightUpdatedAt ?? null);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  /** 该评委在该方案上的评分是否还停留在旧权重版本 */
  function isStaleWeight(item: ScoreRecord | null | undefined) {
    return !!item && item.weightVersion < weightVersion.value;
  }

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify({
      scores: scores.value,
      events: events.value,
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])),
      weightVersion: weightVersion.value,
      weights: Object.fromEntries(criteria.value.map((item) => [item.id, item.weight])),
      weightUpdatedAt: weightUpdatedAt.value
    }));
  }

  /**
   * 多标签页同步：storage 事件只在其他标签页写入时触发。
   * 收到后按 (评委, 方案) 以修订号合并草稿，绝不整片覆盖本页较新的写入；
   * 权重修订号只升不降——旧版本窗口（保存/换权并发时可能后落盘）的数据一律不回灌。
   * 只读取并合并远端数据，不触发本地持久化，避免事件乒乓。
   */
  function handleStorage(event: StorageEvent) {
    if (event.key !== KEY || !event.newValue) return;
    let incoming: any;
    try { incoming = JSON.parse(event.newValue); } catch { return; }

    // 先定权重版本：低版本写入（旧窗口晚落盘）只同步审计事件，其余全部忽略
    const remoteWeightVersion: number = incoming.weightVersion ?? START_WEIGHT_VERSION;
    const outdated = remoteWeightVersion < weightVersion.value;

    if (!outdated) {
      const remoteScores: ScoreRecord[] = (incoming.scores ?? []).map(migrateScore);
      for (const remote of remoteScores) {
        // 远端的旧版本评分不能复活本地已随换版作废的草稿
        if (remote.weightVersion < weightVersion.value) continue;
        const local = scores.value.find((score) => score.judge === remote.judge && score.schemeId === remote.schemeId);
        if (!local) {
          scores.value.push({ ...remote });
        } else if (remote.revision > local.revision) {
          Object.assign(local, remote);
        }
      }
      // 另一端缺失的当前版本记录只可能是换版后被作废的未提交草稿，本地同步作废；
      // 本地独有的旧版本定稿保留审计痕迹
      const remoteKeys = new Set(remoteScores.map((score) => score.id));
      scores.value = scores.value.filter((score) => remoteKeys.has(score.id) || score.weightVersion < weightVersion.value);

      if (remoteWeightVersion >= weightVersion.value && incoming.weights) {
        criteria.value = criteria.value.map((item) => ({ ...item, weight: incoming.weights[item.id] ?? item.weight }));
        weightVersion.value = remoteWeightVersion;
        weightUpdatedAt.value = incoming.weightUpdatedAt ?? weightUpdatedAt.value;
      }

      if (typeof incoming.published === "boolean" && (!incoming.published || !published.value)) {
        published.value = incoming.published;
      }
      if (incoming.schemeStatuses) {
        schemes.value.forEach((scheme) => {
          const status = incoming.schemeStatuses[scheme.id];
          if (status) scheme.status = status;
        });
      }
    }

    // 审计事件始终按 id 取并集，各标签页的记录互不覆盖
    if (Array.isArray(incoming.events)) {
      let changed = false;
      const known = new Map(events.value.map((logEvent) => [logEvent.id, logEvent]));
      for (const logEvent of incoming.events) {
        if (!known.has(logEvent.id)) { known.set(logEvent.id, logEvent); changed = true; }
      }
      if (changed) events.value = [...known.values()].sort((a, b) => (a.time < b.time ? 1 : -1));
    }
  }

  if (typeof window !== "undefined") window.addEventListener("storage", handleStorage);

  function findRecord(currentJudge: Viewer, schemeId: string) {
    return scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId) ?? null;
  }

  /** 读取当前评委在某方案上的评分（不存在不建档，避免空修订记录） */
  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    return findRecord(currentJudge, schemeId);
  }

  function ensureRecord(currentJudge: Viewer, schemeId: string) {
    let item = findRecord(currentJudge, schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId, weightVersion.value);
      scores.value.push(item);
    }
    return item;
  }

  /**
   * 保存草稿（乐观并发）。
   * base 为本窗口加载/上次保存后看到的评分快照，payload 为本窗口编辑内容：
   * - 当前修订号 !== base.revision => 另一窗口已写入，返回 conflict 先停下
   * - 权重版本落后 => 拒绝写入，草稿必须按新权重重算
   * - 已锁定/已定稿 => 拒绝写入
   * 评委在冲突弹窗确认后带 force=true 覆盖写回，修订号在最新值上 +1。
   */
  function saveDraft(schemeId: string, base: ScoreSnapshot, payload: ScorePayload, force = false): SaveOutcome {
    const currentJudge = judge.value;
    if (!currentJudge || published.value) return { ok: false, reason: "locked" };

    const item = ensureRecord(currentJudge, schemeId);
    if (item.submitted && item.weightVersion >= weightVersion.value) {
      // 当前版本已定稿：不能再存草稿
      return { ok: false, reason: "already-submitted" };
    }
    // 本窗口依据的权重版本落后 => 旧窗口拒绝写入，必须按新权重重算
    if (payload.weightVersion < weightVersion.value) {
      return { ok: false, reason: "weight-stale", latestWeightVersion: weightVersion.value };
    }
    // 旧版本定稿按新权重重新打草稿：自动退回编辑态
    if (item.submitted) item.submitted = false;
    if (!force && item.revision !== base.revision) {
      return {
        ok: false,
        reason: "conflict",
        conflict: { base: { ...base }, incoming: { ...payload }, latest: snapshotOf(item) }
      };
    }

    item.values = { ...payload.values };
    item.comment = payload.comment;
    item.conflict = payload.conflict;
    // 覆盖写回以最新修订号为基，绝不回退另一窗口的修订号
    item.revision = Math.max(item.revision, base.revision) + 1;
    item.weightVersion = weightVersion.value;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    log("保存评分草稿", `${scheme?.code ?? schemeId}（修订 ${item.revision}）${payload.conflict ? "，声明利益冲突" : ""}`);
    persist();
    return { ok: true, revision: item.revision };
  }

  /**
   * 提交评分：同样要求修订号匹配且权重最新。
   * 冲突时停在确认环节，本人确认后带 force=true 在最新修订号上定稿。
   */
  function submit(schemeId: string, base: ScoreSnapshot, payload: ScorePayload, force = false): SubmitOutcome {
    const currentJudge = judge.value;
    if (!currentJudge || published.value) return { ok: false, reason: "locked", latestWeightVersion: weightVersion.value };

    const item = ensureRecord(currentJudge, schemeId);
    // 本窗口依据的权重版本落后 => 旧窗口拒绝写入，必须按新权重重算
    if (payload.weightVersion < weightVersion.value) {
      return { ok: false, reason: "weight-stale", latestWeightVersion: weightVersion.value };
    }
    if (!force && item.revision !== base.revision) {
      return {
        ok: false,
        reason: "conflict",
        conflict: { base: { ...base }, incoming: { ...payload }, latest: snapshotOf(item) }
      };
    }

    item.values = { ...payload.values };
    item.comment = payload.comment;
    item.conflict = payload.conflict;
    item.submitted = true;
    item.revision = Math.max(item.revision, base.revision) + 1;
    item.weightVersion = weightVersion.value;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedOnCurrentWeights(schemeId) ? "已提交" : "评分中";
    log("提交评分", `${scheme?.code ?? schemeId}（修订 ${item.revision}，权重版本 ${weightVersion.value}）`);
    persist();
    return { ok: true, revision: item.revision };
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    item.submitted = false;
    item.revision += 1;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = "评分中";
    log("退回评分修改", `${scheme?.code ?? schemeId}（修订 ${item.revision}）`);
    persist();
  }

  /** 未按最新权重提交的定稿数量：权重变更后这些提交需评委按新权重重打 */
  const staleSubmittedCount = computed(() =>
    scores.value.filter((score) => score.submitted && score.weightVersion < weightVersion.value).length
  );

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      // 只认最新权重版本的评分，旧版本一律不进入锁定结果
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict && score.weightVersion === weightVersion.value);
      const total = rows.length ? rows.reduce((sum, row) => sum + criteria.value.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length : 0;
      return { ...scheme, total: Number(total.toFixed(2)), judgeCount: rows.length, conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict && score.weightVersion === weightVersion.value).length };
    }).sort((a, b) => b.total - a.total);
  });

  function publish() {
    // 锁定发布只认最新权重版本：任一评委的定稿不是当前版本都不能锁
    if (!schemes.value.every((scheme) => allSubmittedOnCurrentWeights(scheme.id))) return;
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案，权重版本 ${weightVersion.value}`);
    persist();
  }

  function allSubmittedOnCurrentWeights(schemeId: string) {
    return judges.every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted && score.weightVersion === weightVersion.value));
  }

  /**
   * 主办方调整权重：版本号 +1，所有未提交草稿（含旧版本）一律作废，
   * 评委进入方案时需按新权重重算；已经提交的定稿标记为旧版本，须重新提交。
   */
  function updateWeights(weights: Record<string, number>): WeightUpdateOutcome {
    if (!isOrganizer.value) return { ok: false, reason: "organizer-only" };
    if (published.value) return { ok: false, reason: "locked" };
    const next = criteria.value.map((item) => weights[item.id]);
    if (next.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
      return { ok: false, reason: "bad-weights" };
    }
    const total = next.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 100) > 0.001) return { ok: false, reason: "bad-weights" };
    if (next.every((value, index) => value === criteria.value[index].weight)) {
      return { ok: true, version: weightVersion.value, staleDrafts: 0 };
    }

    weightVersion.value += 1;
    criteria.value = criteria.value.map((item) => ({ ...item, weight: weights[item.id] }));
    weightUpdatedAt.value = new Date().toISOString();

    // 未提交草稿作废：直接清除，评委下次打开以全新草稿按新权重打分
    const before = scores.value.length;
    scores.value = scores.value.filter((score) => score.submitted);
    const dropped = before - scores.value.length;
    // 已提交但基于旧权重的定稿：保留 submitted 审计痕迹与旧版本号，
    // 不直接翻状态；锁定门槛（只认最新权重版本）会自然拦住，
    // 评委端看到"旧版本定稿"提示后按新权重重算并重新提交。
    const staleFinalized = scores.value.filter((score) => score.weightVersion < weightVersion.value).length;
    schemes.value.forEach((scheme) => {
      if (scheme.status !== "待评分") scheme.status = allSubmittedOnCurrentWeights(scheme.id) ? "已提交" : "评分中";
    });

    log("调整评分权重", `权重版本升至 ${weightVersion.value}，${dropped} 份未提交草稿作废重算，${staleFinalized} 份旧版定稿待重交`);
    persist();
    return { ok: true, version: weightVersion.value, staleDrafts: dropped };
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  // 所有写操作（保存/提交/退回/锁定/换权重）内部显式 persist；
  // storage 同步进来的远端数据不再经 watch 回写，避免多标签页事件乒乓。

  return {
    viewer,
    schemes,
    criteria,
    judges,
    scores,
    events,
    published,
    weightVersion,
    weightUpdatedAt,
    staleSubmittedCount,
    ranking,
    visibleScores,
    isOrganizer,
    judge,
    setViewer,
    record,
    isStaleWeight,
    saveDraft,
    submit,
    recalled,
    publish,
    allSubmittedOnCurrentWeights,
    updateWeights
  };
});
