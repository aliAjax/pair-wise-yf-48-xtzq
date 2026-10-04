export type Viewer = "评委-林策" | "评委-周筑" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

export interface ScoreRecord {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  conflict: boolean;
  updatedAt: string;
  /** 评分草稿/定稿的修订号：每次写回 +1，用于多标签页乐观并发合并 */
  revision: number;
  /** 本条评分所依据的权重修订号；与当前权重版本不一致即为旧版本 */
  weightVersion: number;
}

/** 评分在某一修订号下的完整快照 */
export interface ScoreSnapshot {
  revision: number;
  updatedAt: string;
  values: Record<string, number>;
  comment: string;
  conflict: boolean;
  weightVersion: number;
}

/** 本窗口准备写入的内容（不带修订号，weightVersion 标明这份编辑依据的权重版本） */
export interface ScorePayload {
  values: Record<string, number>;
  comment: string;
  conflict: boolean;
  weightVersion: number;
}

/** 保存冲突时带回的三方快照：本窗口基线 / 本窗口待写 / 服务端最新，供评委对照后决定 */
export interface ScoreConflict {
  base: ScoreSnapshot;
  incoming: ScorePayload;
  latest: ScoreSnapshot;
}

export interface SaveOutcome {
  ok: boolean;
  reason?: "locked" | "already-submitted" | "weight-stale" | "conflict";
  revision?: number;
  latestWeightVersion?: number;
  conflict?: ScoreConflict;
}

export interface SubmitOutcome {
  ok: boolean;
  reason?: "locked" | "weight-stale" | "conflict";
  revision?: number;
  latestWeightVersion?: number;
  conflict?: ScoreConflict;
}

export type WeightUpdateOutcome =
  | { ok: true; version: number; staleDrafts: number }
  | { ok: false; reason: "organizer-only" | "locked" | "bad-weights" };

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
