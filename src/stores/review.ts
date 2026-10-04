import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import type { Criterion, ReviewEvent, Scheme, SchemeStatus, ScoreRecord, Viewer } from "../types";

const KEY = "pair-wise-yf-48/review";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
/** 评分维度定义（名称与说明固定，权重随权重修订号变化） */
const criterionDefs: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

interface PersistedState {
  scores?: ScoreRecord[];
  events?: ReviewEvent[];
  published?: boolean;
  schemeStatuses?: Record<string, SchemeStatus>;
  weightRevision?: number;
  weights?: Record<string, number>;
}

/** 保存/提交的返回结果：冲突时携带对方已保存的最新版本 */
export type SaveResult =
  | { status: "saved"; record: ScoreRecord }
  | { status: "submitted"; record: ScoreRecord }
  | { status: "conflict"; latest: ScoreRecord; baseRevision: number };

function readState(): PersistedState {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as PersistedState;
  } catch {
    return {};
  }
}

function emptyScore(judge: Viewer, schemeId: string, weightRevision: number): ScoreRecord {
  return {
    id: `${judge}-${schemeId}`,
    judge,
    schemeId,
    values: Object.fromEntries(criterionDefs.map((item) => [item.id, 60])),
    comment: "",
    submitted: false,
    conflict: false,
    updatedAt: new Date().toISOString(),
    revision: 1,
    weightRevision
  };
}

export const useReviewStore = defineStore("review", () => {
  const initial = readState();
  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores ?? []);
  const events = ref<ReviewEvent[]>(initial.events ?? []);
  const published = ref<boolean>(initial.published ?? false);
  /** 权重修订号：主办方每调整一次权重 +1 */
  const weightRevision = ref<number>(initial.weightRevision ?? 1);
  const weights = ref<Record<string, number>>(
    Object.fromEntries(criterionDefs.map((item) => [item.id, initial.weights?.[item.id] ?? item.weight]))
  );

  /** 当前生效的评分维度（权重取自最新权重版本） */
  const criteria = computed<Criterion[]>(() => criterionDefs.map((item) => ({ ...item, weight: weights.value[item.id] ?? item.weight })));

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId, weightRevision.value);
      scores.value.push(item);
    }
    return item;
  }

  function buildPayload() {
    return {
      scores: scores.value,
      events: events.value,
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])) as Record<string, SchemeStatus>,
      weightRevision: weightRevision.value,
      weights: weights.value
    };
  }

  const statusOrder: Record<SchemeStatus, number> = { "待评分": 0, "评分中": 1, "已提交": 2, "已锁定": 3 };

  /**
   * 落盘前与 localStorage 中的最新状态合并，避免用本窗口的陈旧副本盖掉其他窗口的更新：
   * 评分记录取修订号更高的版本，事件按 id 并集，方案状态取进展最靠前的，权重取修订号更高的版本。
   */
  function mergeState(local: ReturnType<typeof buildPayload>): ReturnType<typeof buildPayload> {
    const remote = readState();
    const remoteScores = remote.scores ?? [];
    const mergedScores = local.scores.map((score) => {
      const found = remoteScores.find((item) => item.id === score.id);
      return found && found.revision > score.revision ? { ...found } : { ...score };
    });
    for (const score of remoteScores) {
      if (!mergedScores.some((item) => item.id === score.id)) mergedScores.push({ ...score });
    }
    const remoteEvents = remote.events ?? [];
    const mergedEvents = local.events.map((event) => ({ ...event }));
    for (const event of remoteEvents) {
      if (!mergedEvents.some((item) => item.id === event.id)) mergedEvents.push({ ...event });
    }
    const remoteStatuses = remote.schemeStatuses ?? {};
    const mergedStatuses: Record<string, SchemeStatus> = {};
    for (const [id, status] of Object.entries(local.schemeStatuses)) {
      const remoteStatus = remoteStatuses[id];
      mergedStatuses[id] = remoteStatus && statusOrder[remoteStatus] > statusOrder[status] ? remoteStatus : status;
    }
    const mergedPublished = local.published || (remote.published ?? false);
    const remoteWeightRevision = remote.weightRevision ?? 1;
    const mergedWeightRevision = Math.max(local.weightRevision, remoteWeightRevision);
    const mergedWeights = local.weightRevision >= remoteWeightRevision ? { ...local.weights } : { ...(remote.weights ?? local.weights) };
    return {
      scores: mergedScores,
      events: mergedEvents,
      published: mergedPublished,
      schemeStatuses: mergedStatuses,
      weightRevision: mergedWeightRevision,
      weights: mergedWeights
    };
  }

  // 同步落盘，保证内存态与 localStorage 始终一致；落盘前合并其他窗口的最新更新
  let lastWritten = "";
  watch([scores, events, published, schemes, weightRevision, weights], () => {
    const merged = mergeState(buildPayload());
    const payload = JSON.stringify(merged);
    if (payload === lastWritten) return;
    lastWritten = payload;
    localStorage.setItem(KEY, payload);
  }, { deep: true, flush: "sync" });

  // 监听其他标签页的写入，实时同步修订号与权重版本
  function applyRemote(event: StorageEvent) {
    if (event.key !== KEY || !event.newValue) return;
    lastWritten = event.newValue;
    const state = JSON.parse(event.newValue) as PersistedState;
    if (state.scores) scores.value = state.scores;
    if (state.events) events.value = state.events;
    if (typeof state.published === "boolean") published.value = state.published;
    if (typeof state.weightRevision === "number") weightRevision.value = state.weightRevision;
    if (state.weights) weights.value = state.weights;
    if (state.schemeStatuses) {
      for (const scheme of schemes.value) {
        const status = state.schemeStatuses[scheme.id];
        if (status) scheme.status = status;
      }
    }
  }
  window.addEventListener("storage", applyRemote);

  /**
   * 写入评分草稿/提交结果（乐观并发控制）。
   * 以 localStorage 中的最新版本为准：若同一评委对同一方案已存在更新的修订号，
   * 且本次不是本人确认后的强制写入，则返回冲突，由界面提示合并。
   */
  function writeScore(
    schemeId: string,
    values: Record<string, number>,
    comment: string,
    conflict: boolean,
    submitted: boolean,
    baseRevision: number,
    force: boolean
  ): SaveResult {
    const currentJudge = judge.value;
    if (!currentJudge) throw new Error("仅评委可以写入评分");
    const persisted = readState();
    const persistedScores = (persisted.scores ?? []).map((score) => ({ ...score }));
    const latest = persistedScores.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!force && latest && latest.revision > baseRevision) {
      return { status: "conflict", latest, baseRevision };
    }
    const now = new Date().toISOString();
    let next: ScoreRecord;
    if (latest) {
      next = {
        ...latest,
        values: { ...values },
        comment,
        conflict,
        submitted,
        updatedAt: now,
        revision: latest.revision + 1,
        weightRevision: weightRevision.value
      };
      const index = persistedScores.findIndex((score) => score.id === latest.id);
      persistedScores[index] = next;
    } else {
      next = {
        ...emptyScore(currentJudge, schemeId, weightRevision.value),
        values: { ...values },
        comment,
        conflict,
        submitted,
        updatedAt: now
      };
      persistedScores.push(next);
    }
    // 写穿 localStorage 并同步内存态
    lastWritten = JSON.stringify({ ...buildPayload(), scores: persistedScores });
    localStorage.setItem(KEY, lastWritten);
    scores.value = persistedScores;
    return { status: submitted ? "submitted" : "saved", record: next };
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseRevision: number, force = false): SaveResult {
    const result = writeScore(schemeId, values, comment, conflict, false, baseRevision, force);
    if (result.status === "saved") {
      const scheme = schemes.value.find((entry) => entry.id === schemeId);
      if (scheme && scheme.status === "待评分") scheme.status = "评分中";
      log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}${force ? "（冲突经本人确认后合并写入）" : ""}`);
    }
    return result;
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseRevision: number, force = false): SaveResult {
    const result = writeScore(schemeId, values, comment, conflict, true, baseRevision, force);
    if (result.status === "submitted") {
      const scheme = schemes.value.find((entry) => entry.id === schemeId);
      if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
      log("提交评分", `${scheme?.code ?? schemeId}（权重 v${weightRevision.value}）`);
    }
    return result;
  }

  function recalled(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge || published.value) return;
    // 以 localStorage 最新版本为准做读-改-写，避免用陈旧副本盖掉其他窗口的更新
    const persisted = readState();
    const persistedScores = (persisted.scores ?? []).map((score) => ({ ...score }));
    const latest = persistedScores.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!latest || persisted.published) return;
    latest.submitted = false;
    latest.revision += 1;
    latest.updatedAt = new Date().toISOString();
    lastWritten = JSON.stringify({ ...buildPayload(), scores: persistedScores });
    localStorage.setItem(KEY, lastWritten);
    scores.value = persistedScores;
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
  }

  function allSubmittedFor(schemeId: string) {
    return judges.every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted));
  }

  /** 已提交但所依据的权重版本已过期的评分（锁定发布时不予承认） */
  const staleSubmittedScores = computed(() =>
    scores.value.filter((score) => score.submitted && score.weightRevision < weightRevision.value)
  );

  const ranking = computed(() => {
    if (!published.value) return [];
    return schemes.value.map((scheme) => {
      const rows = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict);
      const total = rows.length ? rows.reduce((sum, row) => sum + criteria.value.reduce((value, criterion) => value + row.values[criterion.id] * criterion.weight / 100, 0), 0) / rows.length : 0;
      return { ...scheme, total: Number(total.toFixed(2)), judgeCount: rows.length, conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict).length };
    }).sort((a, b) => b.total - a.total);
  });

  /** 主办方调整权重：权重修订号 +1，未提交草稿据此作废重算 */
  function updateWeights(next: Record<string, number>) {
    if (published.value) return;
    const before = weightRevision.value;
    weights.value = { ...next };
    weightRevision.value = before + 1;
    log("调整权重", `权重版本 v${before} → v${weightRevision.value}；未提交草稿作废，需按新权重重算确认`);
  }

  /** 锁定发布：只承认最新权重版本下的提交 */
  function publish(): { ok: boolean; reason?: string } {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) {
      return { ok: false, reason: "仍有评委未提交，不能锁定结果" };
    }
    if (staleSubmittedScores.value.length > 0) {
      const minVersion = Math.min(...staleSubmittedScores.value.map((score) => score.weightRevision));
      const detail = staleSubmittedScores.value
        .map((score) => `${schemes.value.find((scheme) => scheme.id === score.schemeId)?.code ?? score.schemeId}（${score.judge}，v${score.weightRevision}）`)
        .join("、");
      return { ok: false, reason: `有 ${staleSubmittedScores.value.length} 份评分按旧权重 v${minVersion} 提交（${detail}），请退回修改并按最新权重 v${weightRevision.value} 重算后再锁定` };
    }
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案，权重版本 v${weightRevision.value}`);
    return { ok: true };
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  return {
    viewer, schemes, criteria, criterionDefs, judges, scores, events, published, weightRevision, weights,
    ranking, visibleScores, staleSubmittedScores, isOrganizer, judge, setViewer,
    record, saveDraft, submit, recalled, publish, updateWeights, allSubmittedFor
  };
});
