// 状态机:检查点开合、动作矩阵、分支操作、inbox 生命周期(tech-design §1.1/§2.2 的纯逻辑部分)。
import { ApiError } from './errors.js';
import { ALLOWED_ACTIONS, DECISION_ACTIONS, type BranchInfo, type Checkpoint, type DecisionAction, type WorkStatus } from './types.js';

/** resolving 动作解决检查点;supplement 只注入材料不解决(tech-design §1 语义约定) */
export function isResolvingAction(action: DecisionAction): boolean {
  return action !== 'supplement';
}

/** 决策后的 work 状态:deliver → done;approve/reject/redirect → active;supplement 不变(null) */
export function statusAfterDecision(action: DecisionAction): WorkStatus | null {
  if (action === 'deliver') return 'done';
  if (action === 'approve' || action === 'reject' || action === 'redirect') return 'active';
  return null;
}

/** 下一个分支 id:main(第1个)+ b2(第2个)+ b3… 与 demo fixture 命名一致,确定性 */
export function nextBranchId(branches: BranchInfo[]): string {
  return 'b' + (branches.length + 1);
}

/**
 * 校验决策请求:action 合法性 + 检查点类型×动作矩阵 + redirect 必带 text。
 * 违规抛 ApiError(400, INVALID_ACTION)(tech-design §2.2 校验链)。
 */
export function validateDecisionInput(cp: Checkpoint, action: unknown, text: string | undefined): DecisionAction {
  if (typeof action !== 'string' || !(DECISION_ACTIONS as readonly string[]).includes(action)) {
    throw new ApiError(400, 'INVALID_ACTION', `unknown action "${String(action)}" (expected one of ${DECISION_ACTIONS.join(', ')})`);
  }
  const act = action as DecisionAction;
  const allowed = ALLOWED_ACTIONS[cp.type];
  if (!allowed.includes(act)) {
    throw new ApiError(400, 'INVALID_ACTION', `action "${act}" is not allowed on a ${cp.type} checkpoint (allowed: ${allowed.join(', ')})`);
  }
  if (act === 'redirect' && (text === undefined || text.trim() === '')) {
    throw new ApiError(400, 'INVALID_ACTION', 'redirect decision requires non-empty text');
  }
  return act;
}
