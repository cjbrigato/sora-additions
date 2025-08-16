import * as SoraTypes from './sora_types'


export type SkippedGeneration = {id?:string, reason:string}
export type PruneReason = 'task_not_succeeded' | 'no_remaining_generations' | 'partially_filtered_generations'
export type PrunedTask =
  | {
      kind: 'total';
      id?: string;
      reason: Extract<PruneReason, 'task_not_succeeded' | 'no_remaining_generations'>;
      skipped_generations?: SkippedGeneration[]; // optionnel: parfois vide
    }
  | {
      kind: 'partial';
      id?: string;
      reason: Extract<PruneReason, 'partially_filtered_generations'>;
      skipped_generations: SkippedGeneration[]; // partial => forcément non vide
    };


    export type FilteredTasks = {
      tasks: SoraTypes.Task[];
      pruning_log: PrunedTask[];            // log par tâche
      skipped_generations: (SkippedGeneration & { task_id?: string })[]; // log “flat”
    };

export type GenMinimalSubset = {id:string,task_id:string}
export type FilterGenerationsResult = {valid: SoraTypes.Generation[], skipped: SkippedGeneration[]}
export type SuccessfullRawResult = {id:string,task_id:string,url:string}
export type FailedRawResult = {id:string,task_id:string,reason:string}
export type FetchRawResult = {successes:SuccessfullRawResult[],failures:FailedRawResult[]}



export function filterTasks(tasks: SoraTypes.Task[]):FilteredTasks {
  const filteredTasks:FilteredTasks = {tasks:[],pruning_log:[],skipped_generations:[]}
  // should splice the unsucceded tasks
  for (const t of tasks) {
    if (t?.status !== 'succeeded') {
      filteredTasks.pruning_log.push({ kind: 'total', id:t?.id, reason:t?.failure_reason || 'task_not_succeeded' });
      continue;
    }
    const filteredGenerations = filterGenerations([t])
    t.generations = filteredGenerations.valid
    if (t.generations.length > 0) {
      filteredTasks.tasks.push(t)
      if (filteredGenerations.skipped.length > 0) {
        filteredTasks.pruning_log.push({ kind: 'partial', id:t?.id, skipped_generations:filteredGenerations.skipped, reason:('partially_filtered_generations')});
      }
    }
    else {
      filteredTasks.pruning_log.push({ kind: 'total', id:t?.id, skipped_generations:filteredGenerations.skipped, reason:('no_remaining_generations')});
    }
    filteredTasks.skipped_generations.push(...filteredGenerations.skipped.map(s => ({ id:s.id, task_id:t?.id, reason:s.reason })))
  }
  return filteredTasks;
}

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
