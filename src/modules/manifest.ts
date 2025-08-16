import * as SoraTypes from './sora_types'

type CSVManifestRow = { id: string; task_id: string; filename: string; url: string }
type CSVManifest = { rows: CSVManifestRow[]; skipped: string[]; failures: { id: string; reason: string }[]; mode: string; quality: string }

type ManifestGeneration = SoraTypes.Generation & { result_filename: string, result_url: string }
type ManifestTask = SoraTypes.Task & { generations: ManifestGeneration[] }

type JSONManifestGeneration = { id: string, filename: string, url: string }
type JSONManifestTask = { id: string, generations: JSONManifestGeneration[] }
type JSONManifest = { tasks: JSONManifestTask[], skipped: string[], failures: { id: string; reason: string }[]; mode: string; quality: string }

export type Manifest = {
    csv: CSVManifest,
    json: JSONManifest
}

export function makeManifestGeneration(generation: SoraTypes.Generation, result_filename: string, result_url: string): ManifestGeneration {
    return {
        ...generation,
        result_filename: result_filename,
        result_url: result_url
    }
}

export function makeManifestTask(task: SoraTypes.Task, generations: ManifestGeneration[]): ManifestTask {
    return {
        ...task,
        generations: generations
    }
}

export function makeManifestTaskFromTaskAndGenerations(task: SoraTypes.Task, generations: { generation: SoraTypes.Generation, result_filename: string, result_url: string }[]): ManifestTask {
    return makeManifestTask(task, generations.map(g => makeManifestGeneration(g.generation, g.result_filename, g.result_url)))
}


export function generateCSVManifestRows(tasks: ManifestTask[]): CSVManifestRow[] {
    let rows: CSVManifestRow[] = []
    for (const task of tasks) {
        for (const generation of task.generations) {
            rows.push({ id: generation.id, task_id: task.id, filename: generation.result_filename, url: generation.result_url })
        }
    }
    return rows
}

export function generateCSVManifest(tasks: ManifestTask[],
    mode: 'fast' | 'final' | 'images',
    quality: string,
    failures: { id: string, reason: string }[]): CSVManifest {
    const manifest: CSVManifest = { rows: [], skipped: [], failures: [], mode: 'final', quality: 'source' }
    manifest.rows = generateCSVManifestRows(tasks)
    manifest.failures = failures
    manifest.mode = mode
    manifest.quality = quality
    return manifest
}

export function CSVManifestToCSV(manifest: CSVManifest): string {
    const csvHeader = ['task_id', 'id', 'filename', 'url', 'mode', 'quality'];
    const toCSV = (v: string) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const csvRows = [csvHeader.join(',')].concat(manifest.rows.map(r =>
        [r.task_id, r.id, toCSV(r.filename), toCSV(r.url), manifest.mode, manifest.quality].join(',')
    ));
    return csvRows.join('\n');
}

export function generateJSONManifestTasks(tasks: ManifestTask[]): JSONManifestTask[] {
    let json_tasks: JSONManifestTask[] = []
    for (const task of tasks) {
        let json_task: JSONManifestTask = { id: task.id, generations: [] }
        for (const generation of task.generations) {
            json_task.generations.push({ id: generation.id, filename: generation.result_filename, url: generation.result_url })
        }
        json_tasks.push(json_task)
    }
    return json_tasks
}

export function generateJSONManifest(tasks: ManifestTask[],
    mode: 'fast' | 'final' | 'images',
    quality: string,
    failures: { id: string, reason: string }[]): JSONManifest {
    const manifest: JSONManifest = { tasks: [], skipped: [], failures: [], mode: 'final', quality: 'source' }
    manifest.tasks = generateJSONManifestTasks(tasks)
    manifest.failures = failures
    manifest.mode = mode
    manifest.quality = quality
    return manifest
}

export function JSONManifestToJSON(manifest: JSONManifest): string {
    return JSON.stringify(manifest, null, 2)
}