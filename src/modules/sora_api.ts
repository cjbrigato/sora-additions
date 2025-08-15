import * as SoraTypes from './sora_types'

export type GenMinimalSubset = {id:string,task_id:string}
export type FilterGenerationsResult = {valid: SoraTypes.Generation[], skipped: {id?:string, reason:string}[]}
export type SuccessfullRawResult = {id:string,task_id:string,url:string}
export type FailedRawResult = {id:string,task_id:string,reason:string}
export type FetchRawResult = {successes:SuccessfullRawResult[],failures:FailedRawResult[]}


export function filterGenerations(tasks: SoraTypes.Task[]):FilterGenerationsResult {
  const fileredResult:FilterGenerationsResult = {valid:[],skipped:[]}
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (t?.status !== 'succeeded') { fileredResult.skipped.push({ id:t?.id, reason:t?.failure_reason || 'Task not succeeded' }); continue; }
    const gens = t?.generations;
    if (!Array.isArray(gens) || gens.length === 0) {
      fileredResult.skipped.push({ id:t?.id, reason: t?.moderation_result?.is_output_rejection ? 'Content policy rejection' : 'No generations' });
      continue;
    }
    for (const g of gens) {
      const e = g?.encodings;
      if (e?.source?.path || e?.md?.path || e?.ld?.path) fileredResult.valid.push(g);
      else fileredResult.skipped.push({ id:g?.id || t?.id, reason:'Missing video file (encodings)' });
    }
  }
  return fileredResult;
}

export function countValidTasks(tasks: SoraTypes.Task[]) {
  let count = 0;
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (t?.status !== 'succeeded') continue;
    const gens = t?.generations; if (!Array.isArray(gens) || gens.length===0) continue;
    if (gens.some(g => g?.encodings?.source?.path || g?.encodings?.md?.path || g?.encodings?.ld?.path)) count++;
  }
  return count;
}

export async function fetchRawWithConcurrency(
  gen_subsets: GenMinimalSubset[],
  concurrency: number,
  onProgress: (txt:string,pct:number)=>void,
  send: (p:any)=>Promise<any>
):Promise<FetchRawResult> {
  const queue = gen_subsets.slice();
  const result:FetchRawResult = {successes:[],failures:[]}
  let processed = 0, total = gen_subsets.length;

  async function worker() {
    while (queue.length) {
      const gen = queue.shift()!;
      const res = await send({ type: 'FETCH_RAW_ONE', id:gen.id });
      if (res?.ok && res.url) result.successes.push({ id:gen.id, task_id:gen.task_id, url: res.url });
      else result.failures.push({ id:gen.id, task_id:gen.task_id, reason: res?.error || 'Unknown error' });
      processed++;
      onProgress(`Step 2/3: Fetching URLs (${processed}/${total})`, total ? (processed/total*100) : 0);
    }
  }
  await Promise.all(Array(Math.min(concurrency, Math.max(1, total))).fill(0).map(worker));
  result.successes.sort((a,b)=> gen_subsets.findIndex(g=>g.id===a.id)-gen_subsets.findIndex(g=>g.id===b.id));
  return result;
}
