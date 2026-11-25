/**
 * 官方判分轨纯面（无 driver、无副作用——可被任意 tsx 入口安全 import）。
 *
 * 从 judge-official.ts 抽出的单一来源：模板、填参、abstention 判定、contains-yes
 * 判读、系统提示词、版本号。模板逐字照抄 LongMemEval 官方 evaluate_qa.py
 * get_anscheck_prompt；判读 = 官方原样 contains-yes——照抄不修（换 judge 模型时
 * 松紧随输出习惯漂移，属已知面）。
 *
 * 抽出的动因：judge-official.ts 是带 main() 的 driver，其 VITEST 守卫只挡测试
 * 面——非 vitest 的 tsx 进程 import 它（如 exo/judge-qa.ts 复用官方轨）会在
 * import 瞬间触发 driver main()。纯面归本件、driver 只留流程（同 judge-core.ts
 * 之于 judge.ts 的既有分层）。
 */

/** 判分提示词版本（进 judge-official.json 与报告读数）。r1：弃权模板句尾问句
 *  照官方原文校正（r0 多了 "response" 一词——与官方 evaluate_qa.py 逐字对账发现）；
 *  模板改动 = 判分口径改动，存量重判离线零答题成本。 */
export const OFFICIAL_PROMPT_VERSION = 'official-evalqa-r1';

export const OFFICIAL_SYSTEM = 'You are an impartial judge. Follow the instructions in the prompt exactly.';

// ---- 官方 prompt 模板（evaluate_qa.py get_anscheck_prompt 逐字照抄）---------------

const T_SINGLE = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
const T_TEMPORAL = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model\'s response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
const T_KU = 'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
const T_PREF = 'I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user\'s personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.';
const T_ABSTENTION = 'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.';

/** abstention 判定（引擎同款双保险）：qid 带 _abs 后缀或数据集题型 = abstention。 */
export function isAbstention(qid: string, categoryLabel?: string): boolean {
  return qid.endsWith('_abs') || categoryLabel === 'abstention';
}

/** 官方模板选择与填参（Python str.format 顺序占位 → 顺序替换首个 {}）。
 *  未知题型且非 abstention → 抛错（官方 NotImplementedError 同款——fail fast）。 */
export function officialPrompt(task: string, question: string, answer: string, response: string, abstention: boolean): string {
  let template: string;
  if (abstention) {
    template = T_ABSTENTION;
  } else if (task === 'single-session-user' || task === 'single-session-assistant' || task === 'multi-session') {
    template = T_SINGLE;
  } else if (task === 'temporal-reasoning') {
    template = T_TEMPORAL;
  } else if (task === 'knowledge-update') {
    template = T_KU;
  } else if (task === 'single-session-preference') {
    template = T_PREF;
  } else {
    throw new Error(`官方模板无此题型：${task}（abstention=${abstention}）`);
  }
  return [question, answer, response].reduce((s, v) => s.replace('{}', v), template);
}

/** 官方判读（label = bool(resp) and 'yes' in resp.lower()）：空响应 = false（错）。
 *  substring 语义是官方原样——"The answer is yes" 也判对，照抄不修。 */
export function officialLabel(resp: string): boolean {
  return resp.trim().length > 0 && resp.toLowerCase().includes('yes');
}
