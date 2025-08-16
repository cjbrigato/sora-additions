import * as SoraTypes from './sora_types'


type SkippedGeneration = { id?: string, reason: string }
type PruneReason = 'task_not_succeeded' | 'no_remaining_generations' | 'partially_filtered_generations'
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


type FilteredTasks = {
  tasks: SoraExtendedTask[];
  pruning_log: PrunedTask[];            // log par tâche
  skipped_generations: (SkippedGeneration & { task_id?: string })[]; // log “flat”
};

export type FilterGenerationsResult = { valid: SoraExtendedGeneration[], skipped: SkippedGeneration[] }
export type SuccessfullRawResult = { generation: SoraExtendedGeneration, url: string }
export type FailedRawResult = { generation: SoraExtendedGeneration, reason: string }
export type FetchRawResult = { successes: SuccessfullRawResult[], failures: FailedRawResult[] }

export type SoraExtendedGeneration = SoraTypes.Generation & { result_filename: string, result_url: string }
export type SoraExtendedTask = Omit<SoraTypes.Task, "generations"> & { generations: SoraExtendedGeneration[] }


function extendSoraGeneration(generation: SoraTypes.Generation): SoraExtendedGeneration {
  let result_filename = '';
  if (generation.task_type === 'image_gen') {
    result_filename = `sora_${generation.task_id}_${generation.id}.png`;
  } else if (generation.task_type === 'video_gen') {
    result_filename = `sora_${generation.task_id}_${generation.id}.mp4`;
  }
  const result_url = generation.url || '';
  return { ...generation, result_filename, result_url }
}
function extendSoraTask(task: SoraTypes.Task): SoraExtendedTask {
  return { ...task, generations: task.generations.map(extendSoraGeneration) }
}
export function extendSoraTasks(tasks: SoraTypes.Task[]): SoraExtendedTask[] {
  return tasks.map(extendSoraTask)
}
function emptySoraExtendedTask(task: SoraTypes.Task): SoraExtendedTask {
  return { ...task, generations: [] }
}
export function emptySoraExtendedTasksMap(tasks: SoraTypes.Task[]): Map<string, SoraExtendedTask> {
  const map = new Map<string, SoraExtendedTask>();
  for (const t of tasks) {
    map.set(t.id, emptySoraExtendedTask(t));
  }
  return map;
}


export function filterTasks(tasks: SoraExtendedTask[]): FilteredTasks {
  const filteredTasks: FilteredTasks = { tasks: [], pruning_log: [], skipped_generations: [] }
  for (const t of tasks) {
    if (t?.status !== 'succeeded') {
      filteredTasks.pruning_log.push({ kind: 'total', id: t?.id, reason: t?.failure_reason || 'task_not_succeeded' });
      continue;
    }
    const filteredGenerations = filterGenerations([t])
    t.generations = filteredGenerations.valid
    if (t.generations.length > 0) {
      filteredTasks.tasks.push(t)
      if (filteredGenerations.skipped.length > 0) {
        filteredTasks.pruning_log.push({ kind: 'partial', id: t?.id, skipped_generations: filteredGenerations.skipped, reason: ('partially_filtered_generations') });
      }
    }
    else {
      filteredTasks.pruning_log.push({ kind: 'total', id: t?.id, skipped_generations: filteredGenerations.skipped, reason: ('no_remaining_generations') });
    }
    filteredTasks.skipped_generations.push(...filteredGenerations.skipped.map(s => ({ id: s.id, task_id: t?.id, reason: s.reason })))
  }
  return filteredTasks;
}

function filterGenerations(tasks: SoraExtendedTask[]): FilterGenerationsResult {
  const fileredResult: FilterGenerationsResult = { valid: [], skipped: [] }
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (t?.status !== 'succeeded') { fileredResult.skipped.push({ id: t?.id, reason: t?.failure_reason || 'Task not succeeded' }); continue; }
    const gens = t?.generations;
    if (!Array.isArray(gens) || gens.length === 0) {
      fileredResult.skipped.push({ id: t?.id, reason: t?.moderation_result?.is_output_rejection ? 'Content policy rejection' : 'No generations' });
      continue;
    }
    for (const g of gens) {
      const e = g?.encodings;
      if (e?.source?.path || e?.md?.path || e?.ld?.path) fileredResult.valid.push(g);
      else fileredResult.skipped.push({ id: g?.id || t?.id, reason: 'Missing video file (encodings)' });
    }
  }
  return fileredResult;
}

export async function fetchRawWithConcurrency(
  generations: SoraExtendedGeneration[],
  concurrency: number,
  onProgress: (txt: string, pct: number) => void,
  send: (p: any) => Promise<any>
): Promise<FetchRawResult> {
  const queue = generations.slice();
  const result: FetchRawResult = { successes: [], failures: [] }
  let processed = 0, total = generations.length;

  async function worker() {
    while (queue.length) {
      const gen = queue.shift()!;
      const res = await send({ type: 'FETCH_RAW_ONE', id: gen.id });
      if (res?.ok && res.url) {
        gen.result_url = res.url;
        result.successes.push({ generation: gen, url: res.url });
      }
      else {
        result.failures.push({ generation: gen, reason: res?.error || 'Unknown error' });
      }
      processed++;
      onProgress(`Step 2/3: Fetching URLs (${processed}/${total})`, total ? (processed / total * 100) : 0);
    }
  }
  await Promise.all(Array(Math.min(concurrency, Math.max(1, total))).fill(0).map(worker));
  result.successes.sort((a, b) => generations.findIndex(g => g.id === a.generation.id) - generations.findIndex(g => g.id === b.generation.id));
  return result;
}
