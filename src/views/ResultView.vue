<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { NAlert, NButton, NCard, NEmpty, NInputNumber, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
const store = useReviewStore();
const message = useMessage();
const columns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "加权总分", key: "total" }
];

/** 权重编辑草稿（保存后才升级权重修订号） */
const weightDraft = reactive<Record<string, number>>({});
function syncWeightDraft() {
  for (const item of store.criteria) weightDraft[item.id] = item.weight;
}
syncWeightDraft();
watch(() => store.weightRevision, syncWeightDraft);

const weightSum = computed(() => Object.values(weightDraft).reduce((sum, value) => sum + Number(value || 0), 0));
const weightValid = computed(() => weightSum.value === 100 && Object.values(weightDraft).every((value) => value >= 0 && value <= 100));

function saveWeights() {
  if (!weightValid.value) {
    message.warning("权重之和必须为 100%，且每项在 0–100 之间");
    return;
  }
  store.updateWeights({ ...weightDraft });
  message.success(`权重已更新至 v${store.weightRevision}，未提交草稿作废，需按新权重重算`);
}

function publish() {
  const result = store.publish();
  if (!result.ok) { message.warning(result.reason ?? "操作失败"); return; }
  message.success("评分结果已锁定发布");
}
</script>
<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度。</NAlert>
  <div class="result-grid">
    <NCard title="提交进度"><article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row"><div><b>{{ scheme.code }} {{ scheme.title }}</b><small>{{ store.judges.filter((judge) => store.scores.some((score) => score.schemeId === scheme.id && score.judge === judge && score.submitted)).length }} / {{ store.judges.length }} 已提交</small></div><NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}</NTag></article></NCard>
    <NCard title="评分纪律"><div class="discipline"><p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p><p>存在利益冲突的评分保留审计记录，但不参与最终排名。</p><p>评分提交后可由评委主动退回，结果锁定后不可修改。</p><p>评分草稿带修订号：多窗口同时保存时先提示冲突，经本人确认后才合并写入。</p><p>权重带修订号：调整后未提交草稿作废重算，锁定发布只认最新权重版本。</p></div><NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton></NCard>
  </div>
  <NCard title="权重设置（主办方）" class="weights-card">
    <template #header><div class="card-title"><span>权重设置</span><NTag type="info">当前版本 v{{ store.weightRevision }}</NTag></div></template>
    <NAlert type="warning" show-icon class="weights-note">调整权重后，评委未提交的草稿将作废并按新权重重算；已提交的评分需退回并按新权重重算，否则无法锁定发布。</NAlert>
    <div class="weight-rows">
      <div v-for="item in store.criteria" :key="item.id" class="weight-row"><label><b>{{ item.name }}</b><small>{{ item.description }}</small></label><NInputNumber v-model:value="weightDraft[item.id]" :min="0" :max="100" :disabled="store.published" /><span>%</span></div>
    </div>
    <div class="weight-sum" :class="{ invalid: !weightValid }">权重之和 {{ weightSum }}%{{ weightValid ? "" : "（需等于 100%）" }}</div>
    <NButton type="primary" :disabled="store.published || !weightValid" @click="saveWeights">保存权重并升级版本</NButton>
    <NAlert v-if="store.staleSubmittedScores.length" type="error" show-icon class="weights-note">有 {{ store.staleSubmittedScores.length }} 份已提交评分依据旧权重，请退回修改并按最新权重 v{{ store.weightRevision }} 重算，否则无法锁定发布。</NAlert>
  </NCard>
  <NCard title="最终排名" class="ranking"><NEmpty v-if="!store.published" description="锁定后查看最终排名" /><NTable v-else :columns="columns" :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))" :bordered="false" /></NCard>
</template>
