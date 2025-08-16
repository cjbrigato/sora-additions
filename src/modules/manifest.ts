import { PrunedTask, SoraExtendedTask } from './sora_api';
import * as SoraTypes from './sora_types'


export type JSONManifestGeneration = { id: string, filename: string, url: string }
export type JSONManifestTask = { id: string, generations: JSONManifestGeneration[] }
export type JSONManifest = { task_type: string,tasks: JSONManifestTask[], pruned: PrunedTask[], failures: { id: string; reason: string }[]; mode: string; quality: string }

export function generateJSONManifestTasks(tasks: SoraExtendedTask[]): JSONManifestTask[] {
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

export function generateJSONManifest(task_type: string,tasks: SoraExtendedTask[],pruned: PrunedTask[],
    mode: 'fast' | 'final' | 'images',
    quality: string,
    failures: { id: string, reason: string }[]): JSONManifest {
    const manifest: JSONManifest = { task_type: task_type, tasks: generateJSONManifestTasks(tasks), pruned: pruned, failures: failures, mode: mode, quality: quality }
    return manifest
}

export function JSONManifestToJSON(manifest: JSONManifest): string {
    return JSON.stringify(manifest, null, 2)
}