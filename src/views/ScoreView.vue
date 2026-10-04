<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NModal, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import type { SaveResult } from "../stores/review";
import type { ScoreRecord } from "../types";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const form = reactive({ values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>, comment: "", conflict: false });
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

/** 本窗口加载草稿时所依据的评分修订号，用于乐观并发校验 */
const baseRevision = ref(0);

function loadForm() {
  const record = store.record(selected.value.id);
  form.values = { ...(record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = record?.comment ?? "";
  form.conflict = record?.conflict ?? false;
  baseRevision.value = record?.revision ?? 0;
}

watch(selectedId, () => {
  conflict.show = false;
  loadForm();
}, { immediate: true });

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const disabled = computed(() => store.isOrganizer || currentScore.value?.submitted || store.published);
/** 权重修订号落后：未提交草稿已作废，需按最新权重重算确认 */
const stale = computed(() => !!currentScore.value && !currentScore.value.submitted && currentScore.value.weightRevision < store.weightRevision);

/** 草稿修订冲突弹窗 */
const conflict = reactive<{ show: boolean; latest: ScoreRecord | null; baseRevision: number }>({ show: false, latest: null, baseRevision: 0 });

function handleResult(result: SaveResult, action: "draft" | "submit") {
  if (result.status === "conflict") {
    conflict.latest = result.latest;
    conflict.baseRevision = result.baseRevision;
    conflict.show = true;
    return;
  }
  baseRevision.value = result.record.revision;
  message.success(action === "draft" ? "评分草稿已保存" : "匿名评分已提交");
}

function draft() {
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, baseRevision.value);
  handleResult(result, "draft");
}

async function submit() {
  if (stale.value) {
    message.warning("权重已更新，请先按新权重重算并确认草稿后再提交");
    return;
  }
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  const r = store.submit(selected.value.id, form.values, form.comment, form.conflict, baseRevision.value);
  handleResult(r, "submit");
}

/** 冲突后本人确认：以本窗口内容合并写入为新修订号 */
function forceWrite() {
  const r = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, conflict.baseRevision, true);
  if (r.status === "conflict") return;
  conflict.show = false;
  baseRevision.value = r.record.revision;
  message.success(`已按本人确认合并写入为 v${r.record.revision}`);
}

/** 放弃本窗口草稿，载入另一窗口已保存的版本 */
function adoptLatest() {
  if (!conflict.latest) return;
  form.values = { ...conflict.latest.values };
  form.comment = conflict.latest.comment;
  form.conflict = conflict.latest.conflict;
  baseRevision.value = conflict.latest.revision;
  conflict.show = false;
  message.info(`已载入 v${conflict.latest.revision} 版本`);
}

function criterionName(id: string) {
  return store.criteria.find((item) => item.id === id)?.name ?? id;
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <NAlert v-if="stale" type="warning" show-icon class="stale-alert">
    <div class="stale-body"><span>权重已更新：当前权重版本为 v{{ store.weightRevision }}，本草稿依据 v{{ currentScore?.weightRevision }}。加权分已按最新权重重算，请确认后再提交。</span><NButton size="small" type="primary" @click="draft">按新权重重算并确认</NButton></div>
  </NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small></button></NCard>
    <NCard class="score-panel">
      <template #header><div class="card-title"><div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div><NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag></div></template>
      <p class="synopsis">{{ selected.synopsis }}</p>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b><NTag size="small" :bordered="false">权重 v{{ store.weightRevision }}</NTag></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后本评分不计入最终排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>
      <div class="actions"><NButton :disabled="disabled" @click="draft">保存草稿</NButton><NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton><NButton v-if="currentScore?.submitted && !store.published" quaternary @click="store.recalled(selected.id)">退回修改</NButton></div>
    </NCard>
  </div>

  <NModal v-model:show="conflict.show" preset="card" title="草稿修订冲突" class="conflict-modal">
    <p class="conflict-lead">检测到同一方案的草稿已在其他窗口保存：本窗口基于修订号 v{{ conflict.baseRevision }}，对方已保存至 v{{ conflict.latest?.revision }}。请确认是否将本窗口内容合并写入为新版本。</p>
    <p v-if="conflict.latest && conflict.latest.weightRevision !== store.weightRevision" class="conflict-note">对方版本依据权重 v{{ conflict.latest.weightRevision }}，当前权重为 v{{ store.weightRevision }}，写入后加权分将按当前权重重算。</p>
    <table class="conflict-table">
      <thead><tr><th>维度</th><th>本窗口草稿（v{{ conflict.baseRevision }}）</th><th>对方已保存（v{{ conflict.latest?.revision }}）</th></tr></thead>
      <tbody>
        <tr v-for="item in store.criteria" :key="item.id"><td>{{ criterionName(item.id) }}</td><td>{{ form.values[item.id] }}</td><td>{{ conflict.latest?.values[item.id] }}</td></tr>
        <tr><td>评审意见</td><td>{{ form.comment || "—" }}</td><td>{{ conflict.latest?.comment || "—" }}</td></tr>
        <tr><td>利益冲突</td><td>{{ form.conflict ? "声明" : "未声明" }}</td><td>{{ conflict.latest?.conflict ? "声明" : "未声明" }}</td></tr>
        <tr><td>最后更新</td><td>—</td><td>{{ conflict.latest?.updatedAt }}</td></tr>
      </tbody>
    </table>
    <template #footer>
      <NButton @click="conflict.show = false">取消</NButton>
      <NButton @click="adoptLatest">采用对方版本</NButton>
      <NButton type="primary" @click="forceWrite">仍要写入，合并为 v{{ (conflict.latest?.revision ?? conflict.baseRevision) + 1 }}</NButton>
    </template>
  </NModal>
</template>
