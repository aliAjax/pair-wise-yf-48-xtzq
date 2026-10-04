<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NModal, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import type { ScoreConflict, ScorePayload, ScoreSnapshot } from "../types";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);

const defaultValues = () => Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>;
const form = reactive({ values: defaultValues(), comment: "", conflict: false });
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

/** 本窗口加载/上次写回后拿到的评分快照；revision 与 weightVersion 是并发判定的依据 */
const base = ref<ScoreSnapshot | null>(null);
/** 另一窗口已保存更新修订号时的提示（被动感知，不打断编辑） */
const remoteNotice = ref(false);
/** 保存/提交冲突的三方快照，弹窗对照后由本人决定 */
const conflictData = ref<ScoreConflict | null>(null);
const conflictAction = ref<"draft" | "submit">("draft");

const liveRecord = computed(() => store.record(selected.value.id));
const baseRevision = computed(() => base.value?.revision ?? 0);
const weightStale = computed(() => !!base.value && base.value.weightVersion < store.weightVersion);
/** 服务端定稿基于旧版权重：评委需按新权重重新打分提交 */
const staleFinalized = computed(() => {
  const live = liveRecord.value;
  return !!live && live.submitted && live.weightVersion < store.weightVersion && !weightStale.value;
});
const remotelyChanged = computed(() => {
  const live = liveRecord.value;
  return !!live && !!base.value && live.revision !== base.value.revision && !conflictData.value;
});
const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
/** 当前版权重已定稿才锁定编辑；旧版本定稿和未提交草稿都允许按新权重重打 */
const finalizedCurrent = computed(() => !!liveRecord.value?.submitted && (liveRecord.value.weightVersion >= store.weightVersion));
const disabled = computed(() => store.isOrganizer || store.published || finalizedCurrent.value || weightStale.value);

function buildBase(record: ReturnType<typeof store.record> | null): ScoreSnapshot {
  if (record) {
    return {
      revision: record.revision,
      updatedAt: record.updatedAt,
      values: { ...record.values },
      comment: record.comment,
      conflict: record.conflict,
      weightVersion: record.weightVersion >= store.weightVersion ? record.weightVersion : store.weightVersion
    };
  }
  // 尚无记录：修订号从 0 起，依据当前权重建档
  return { revision: 0, updatedAt: "", values: defaultValues(), comment: "", conflict: false, weightVersion: store.weightVersion };
}

/**
 * 载入方案到表单。
 * - 当前版本记录（草稿/定稿）：载入已存内容；
 * - 权重换版后未提交草稿已在服务端作废（记录被删除）：回到默认分重新打；
 * - 旧版本定稿：保留原打分作为可编辑参考，提示按新权重修改重交。
 */
function loadScheme() {
  remoteNotice.value = false;
  conflictData.value = null;
  const scoreRecord = store.record(selected.value.id);
  base.value = buildBase(scoreRecord);
  if (scoreRecord) {
    form.values = { ...scoreRecord.values };
    form.comment = scoreRecord.comment;
    form.conflict = scoreRecord.conflict;
  } else {
    form.values = defaultValues();
    form.comment = "";
    form.conflict = false;
  }
}

watch(selectedId, loadScheme, { immediate: true });

// 权重修订号变化：未提交草稿作废，旧窗口停在这里等评委确认重算
watch(() => store.weightVersion, (next) => {
  if (base.value && next > base.value.weightVersion) {
    remoteNotice.value = true;
    conflictData.value = null;
    // 记录若已随换版被删除，表单立即回到空白草稿；旧定稿保留数值待重算
    const record = store.record(selected.value.id);
    if (!record) {
      form.values = defaultValues();
      form.comment = "";
      form.conflict = false;
    }
  }
});

// 另一窗口保存后修订号推进：被动标记，保存时仍会走冲突确认
watch(() => liveRecord.value?.revision, (next, prev) => {
  if (base.value && typeof next === "number" && typeof prev === "number" && next !== prev && next !== base.value.revision) {
    remoteNotice.value = true;
  }
});

function payload(): ScorePayload {
  return { values: { ...form.values }, comment: form.comment, conflict: form.conflict, weightVersion: base.value?.weightVersion ?? store.weightVersion };
}

function handleFailure(outcome: { reason?: string; latestWeightVersion?: number; conflict?: ScoreConflict }, action: "draft" | "submit") {
  if (outcome.reason === "weight-stale") {
    message.warning(`主办方已将权重新版到第 ${outcome.latestWeightVersion} 版，这份草稿依据旧权重，需按新权重重算`);
    return;
  }
  if (outcome.reason === "conflict" && outcome.conflict) {
    conflictData.value = outcome.conflict;
    conflictAction.value = action;
    return;
  }
  if (outcome.reason === "already-submitted") message.info("该方案评分已定稿，不能再保存草稿");
  else if (outcome.reason === "locked") message.error("结果已锁定，评分不可修改");
}

function syncBaseFromLive() {
  const record = store.record(selected.value.id);
  if (record && base.value) base.value = { revision: record.revision, updatedAt: record.updatedAt, values: { ...record.values }, comment: record.comment, conflict: record.conflict, weightVersion: record.weightVersion };
}

function draft() {
  if (!base.value) return;
  const result = store.saveDraft(selected.value.id, base.value, payload());
  if (result.ok && result.revision !== undefined) {
    syncBaseFromLive();
    remoteNotice.value = false;
    message.success(`评分草稿已保存（修订号 ${result.revision}）`);
  } else {
    handleFailure(result, "draft");
  }
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid || !base.value) return;
  const outcome = store.submit(selected.value.id, base.value, payload());
  if (outcome.ok && outcome.revision !== undefined) {
    syncBaseFromLive();
    remoteNotice.value = false;
    message.success(`匿名评分已提交（修订号 ${outcome.revision}，权重版本 ${store.weightVersion}）`);
  } else {
    handleFailure(outcome, "submit");
  }
}

/** 冲突确认：本人明确选择后，以最新修订号为基强制写回 */
const showConflict = computed({
  get: () => conflictData.value !== null,
  set: (value: boolean) => { if (!value) conflictData.value = null; }
});

function resolveConflict(force: boolean) {
  const data = conflictData.value;
  const action = conflictAction.value;
  conflictData.value = null;
  if (!data || !base.value) return;
  if (!force) {
    // 采用另一窗口已保存的版本：载入最新快照继续编辑
    base.value = { ...data.latest };
    form.values = { ...data.latest.values };
    form.comment = data.latest.comment;
    form.conflict = data.latest.conflict;
    remoteNotice.value = false;
    message.info("已载入另一窗口保存的版本");
    return;
  }
  // 以本窗口内容覆盖；先把基线抬到最新修订号，再强制写回
  base.value = { ...data.latest };
  const outcome = action === "submit"
    ? store.submit(selected.value.id, base.value, payload(), true)
    : store.saveDraft(selected.value.id, base.value, payload(), true);
  if (outcome.ok && outcome.revision !== undefined) {
    syncBaseFromLive();
    remoteNotice.value = false;
    message.success(`已按你的内容覆盖写回（修订号 ${outcome.revision}）`);
  } else {
    handleFailure(outcome, action);
  }
}

/** 旧权重窗口确认作废：基线切到最新权重版本，按新权重重算 */
function recalculate() {
  const record = store.record(selected.value.id);
  base.value = buildBase(record);
  if (record && record.weightVersion >= store.weightVersion) {
    form.values = { ...record.values };
    form.comment = record.comment;
    form.conflict = record.conflict;
  } else {
    form.values = defaultValues();
    form.comment = "";
    form.conflict = false;
  }
  remoteNotice.value = false;
  message.info(`已按第 ${store.weightVersion} 版权重重算，请重新打分并提交`);
}

function fmtTime(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

const conflictRows = computed(() => {
  const data = conflictData.value;
  if (!data) return [];
  return store.criteria.map((criterion) => ({
    name: criterion.name,
    mine: data.incoming.values[criterion.id] ?? "—",
    theirs: data.latest.values[criterion.id] ?? "—"
  }));
});
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small></button></NCard>
    <NCard class="score-panel">
      <template #header>
        <div class="card-title">
          <div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div>
          <div class="version-tags">
            <NTag size="small" type="info">权重版本 v{{ store.weightVersion }}</NTag>
            <NTag size="small" :type="remotelyChanged ? 'warning' : 'default'">草稿修订号 r{{ baseRevision }}</NTag>
            <NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag>
          </div>
        </div>
      </template>
      <p class="synopsis">{{ selected.synopsis }}</p>

      <NAlert v-if="weightStale" type="error" show-icon class="banner" title="权重已更新，本窗口编辑依据旧版本">
        <div class="banner-body">
          <span>主办方已将权重新版到第 {{ store.weightVersion }} 版，你窗口里的内容仍按第 {{ base?.weightVersion }} 版权重计算。保存/提交会被拦下，请按新权重重算。</span>
          <NButton size="small" type="primary" @click="recalculate">按新权重重算</NButton>
        </div>
      </NAlert>
      <NAlert v-else-if="staleFinalized" type="warning" show-icon class="banner" title="此评分基于旧版权重，需重新提交">
        <div class="banner-body">
          <span>该定稿依据第 {{ liveRecord?.weightVersion }} 版权重，主办方已更新到第 {{ store.weightVersion }} 版。旧定稿不计入锁定，可参考原值修改后重新提交。</span>
        </div>
      </NAlert>
      <NAlert v-else-if="remotelyChanged || remoteNotice" type="warning" show-icon class="banner" :title="`另一窗口已保存更新（修订号 ${liveRecord?.revision}）`">
        另一个标签页刚写过这份评分（{{ fmtTime(liveRecord?.updatedAt ?? "") }}）。直接保存会先弹出冲突对照，由你确认后才会写回。
      </NAlert>

      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后本评分不计入最终排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>
      <div class="actions">
        <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
        <NButton type="primary" :disabled="disabled" @click="submit">{{ staleFinalized ? "按新权重重交" : "提交本方案评分" }}</NButton>
        <NButton v-if="finalizedCurrent && !store.published" quaternary @click="store.recalled(selected.id)">退回修改</NButton>
      </div>
    </NCard>
  </div>

  <NModal v-model:show="showConflict" preset="card" title="评分保存冲突：请确认后再写回" style="width:min(640px, 92vw)">
    <template v-if="conflictData">
      <p class="conflict-intro">这份评分在另一个标签页已被保存到 <b>修订号 {{ conflictData.latest.revision }}</b>，本窗口依据的是修订号 {{ conflictData.base.revision }}。后到的保存不会直接覆盖，请对照后选择：</p>
      <table class="conflict-table">
        <thead><tr><th>评分维度</th><th>本窗口（待写回）</th><th>另一窗口（已保存）</th></tr></thead>
        <tbody>
          <tr v-for="row in conflictRows" :key="row.name"><td>{{ row.name }}</td><td :class="{ chosen: true }">{{ row.mine }}</td><td>{{ row.theirs }}</td></tr>
          <tr><td>利益冲突</td><td>{{ conflictData.incoming.conflict ? "已声明" : "未声明" }}</td><td>{{ conflictData.latest.conflict ? "已声明" : "未声明" }}</td></tr>
        </tbody>
      </table>
      <div class="conflict-comments">
        <div><small>本窗口意见</small><p>{{ conflictData.incoming.comment || "（空）" }}</p></div>
        <div><small>另一窗口意见 · {{ fmtTime(conflictData.latest.updatedAt) }}</small><p>{{ conflictData.latest.comment || "（空）" }}</p></div>
      </div>
      <div class="conflict-actions">
        <NButton @click="resolveConflict(false)">采用另一窗口版本</NButton>
        <NButton type="primary" @click="resolveConflict(true)">以我的内容覆盖{{ conflictAction === "submit" ? "并提交" : "保存" }}</NButton>
      </div>
    </template>
  </NModal>
</template>
