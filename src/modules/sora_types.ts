export interface VideoGenResponse {
    task_responses: Task[]
    last_id: string
    has_more: boolean
}

export interface Task {
    id: string
    created_at: string
    status: string
    type: string
    prompt: string
    n_variants: number
    n_frames: number
    height: number
    width: number
    generations: Generation[]
    num_unsafe_generations: number
    title: string
    moderation_result: ModerationResult
    failure_reason: any
    needs_user_review: boolean
    actions?: Actions
}

export interface Generation {
    id: string
    task_id: string
    created_at: string
    deleted_at?: string
    url?: string
    seed: number
    can_download: boolean
    download_status: string
    encodings: Encodings
    width: number
    height: number
    n_frames: number
    prompt: string
    title: string
    moderation_result: ModerationResult
    task_type: string
    actions?: Actions
}

export interface Encodings {
    source?: EncodedFile
    source_c2pa?: EncodedFile
    md?: EncodedFile
    ld?: EncodedFile
    thumbnail?: GenericFile
    spritesheet?: GenericFile
    gif?: GenericFile
}

export type EncodedFile =  GenericFile & FileEncoding


export interface GenericFile {
    path: string
    size?: number
}

export interface FileEncoding {
    width?: number
    height?: number
    duration_secs?: number
    ssim?: number
}


export interface ModerationResult {
    type: string
    results_by_frame_index: ResultsByFrameIndex
    code: any
    is_output_rejection: boolean
    task_id: string
}

export interface ResultsByFrameIndex { }

export interface Actions { }