<script setup lang="ts">
import { computed, reactive } from "vue";
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

const draftWeights = reactive<Record<string, number>>(Object.fromEntries(store.criteria.map((item) => [item.id, item.weight])));
const weightSum = computed(() => store.criteria.reduce((sum, item) => sum + (Number(draftWeights[item.id]) || 0), 0));
const weightsValid = computed(() => Math.abs(weightSum.value - 100) < 0.001);
const weightsChanged = computed(() => store.criteria.some((item) => draftWeights[item.id] !== item.weight));

function applyWeights() {
  if (!weightsValid.value) { message.warning(`权重之和需为 100%，当前为 ${weightSum.value}%`); return; }
  if (!weightsChanged.value) { message.info("权重未变化，版本号不变"); return; }
  const outcome = store.updateWeights({ ...draftWeights });
  if (outcome.ok) {
    message.success(`权重已更新到第 ${outcome.version} 版，${outcome.staleDrafts} 份未提交草稿已作废重算；旧版本定稿需评委重新提交`);
  } else if (outcome.reason === "locked") {
    message.error("结果已锁定，权重不可再修改");
  } else {
    message.error("权重需为 0–100 的数值，且总和为 100%");
  }
}

function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedOnCurrentWeights(scheme.id));
  if (!complete) { message.warning(`仍有评委未按第 ${store.weightVersion} 版权重提交，不能锁定结果`); return; }
  store.publish();
  message.success(`评分结果已按第 ${store.weightVersion} 版权重锁定发布`);
}

function fmtTime(iso: string | null) {
  if (!iso) return "尚未调整";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>
<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度。</NAlert>
  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>{{ store.judges.filter((name) => store.scores.some((score) => score.schemeId === scheme.id && score.judge === name && score.submitted && score.weightVersion === store.weightVersion)).length }} / {{ store.judges.length }} 已按当前权重提交</small>
        </div>
        <NTag :type="store.allSubmittedOnCurrentWeights(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedOnCurrentWeights(scheme.id) ? "齐备" : "待提交" }}</NTag>
      </article>
      <NAlert v-if="store.staleSubmittedCount > 0" type="error" show-icon style="margin-top:12px">有 {{ store.staleSubmittedCount }} 份定稿基于旧版权重，权重更新后已退回评分中，须评委按第 {{ store.weightVersion }} 版权重重新提交后方可锁定。</NAlert>
    </NCard>
    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p>
        <p>同一评委同一方案的评分按修订号合并，旧修订号保存会被拦下，由本人确认冲突后写回。</p>
        <p>权重修订号一变，未提交草稿即作废重算；存在利益冲突的评分保留审计记录，但不参与最终排名。</p>
        <p>锁定发布只认最新权重版本，结果锁定后不可修改。</p>
      </div>
      <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
    </NCard>
  </div>

  <NCard class="weight-card">
    <template #header>
      <div class="card-title">
        <div><h2>评分维度权重</h2><small>当前版本 v{{ store.weightVersion }} · 更新于 {{ fmtTime(store.weightUpdatedAt) }}</small></div>
        <NTag :type="weightsValid ? 'success' : 'error'">合计 {{ weightSum }}%</NTag>
      </div>
    </template>
    <div class="weight-editor">
      <div v-for="item in store.criteria" :key="item.id" class="weight-row">
        <div><b>{{ item.name }}</b><small>{{ item.description }}</small><small class="current">生效权重：{{ item.weight }}%</small></div>
        <NInputNumber v-model:value="draftWeights[item.id]" :min="0" :max="100" :disabled="store.published" :show-button="false" style="width:110px" />
      </div>
    </div>
    <div class="actions"><NButton type="primary" :disabled="store.published || !weightsChanged" @click="applyWeights">发布新权重（修订号 +1）</NButton></div>
    <p class="weight-note">调整权重后版本号递增：评委所有未提交草稿立即作废、须按新权重重算；已提交的旧版本定稿退回评分中，重新提交前不能锁定结果。</p>
  </NCard>

  <NCard title="最终排名" class="ranking"><NEmpty v-if="!store.published" description="锁定后查看最终排名" /><NTable v-else :columns="columns" :data="store.ranking.map((item, index) => ({ ...item, rank: index + 1 }))" :bordered="false" /></NCard>
</template>
