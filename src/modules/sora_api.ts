export type Gen = { id: string; encodings?: { source?: {path?:string}, md?:{path?:string}, ld?:{path?:string} }, url?: string, task_id?: string };
export type Task = { id: string; status: string; generations?: Gen[]; failure_reason?: string; moderation_result?: {is_output_rejection?: boolean} };

export function filterGenerations(tasks: Task[]) {
  const valid: Gen[] = [], skipped: {id?:string, reason:string}[] = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (t?.status !== 'succeeded') { skipped.push({ id:t?.id, reason:t?.failure_reason || 'Task not succeeded' }); continue; }
    const gens = t?.generations;
    if (!Array.isArray(gens) || gens.length === 0) {
      skipped.push({ id:t?.id, reason: t?.moderation_result?.is_output_rejection ? 'Content policy rejection' : 'No generations' });
      continue;
    }
    for (const g of gens) {
      const e = g?.encodings;
      if (e?.source?.path || e?.md?.path || e?.ld?.path) valid.push(g);
      else skipped.push({ id:g?.id || t?.id, reason:'Missing video file (encodings)' });
    }
  }
  return { valid, skipped };
}

export function countValidTasks(tasks: Task[]) {
  let count = 0;
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (t?.status !== 'succeeded') continue;
    const gens = t?.generations; if (!Array.isArray(gens) || gens.length===0) continue;
    if (gens.some(g => g?.encodings?.source?.path || g?.encodings?.md?.path || g?.encodings?.ld?.path)) count++;
  }
  return count;
}

export async function fetchRawWithConcurrency(
  ids: string[],
  concurrency: number,
  onProgress: (txt:string,pct:number)=>void,
  send: (p:any)=>Promise<any>
){
  const queue = ids.slice();
  const successes: {id:string,task_id:string,url:string}[] = [], failures: {id:string,task_id:string,reason:string}[] = [];
  let processed = 0, total = ids.length;

  async function worker() {
    while (queue.length) {
      const id = queue.shift()!;
      const res = await send({ type: 'FETCH_RAW_ONE', id });
      if (res?.ok && res.url) successes.push({ id, task_id: res.task_id, url: res.url });
      else failures.push({ id, task_id: res?.task_id, reason: res?.error || 'Unknown error' });
      processed++;
      onProgress(`Step 2/3: Fetching URLs (${processed}/${total})`, total ? (processed/total*100) : 0);
    }
  }
  await Promise.all(Array(Math.min(concurrency, Math.max(1, total))).fill(0).map(worker));
  successes.sort((a,b)=> ids.indexOf(a.id)-ids.indexOf(b.id));
  return { successes, failures };
}
