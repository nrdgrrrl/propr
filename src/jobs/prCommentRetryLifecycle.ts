import type { Job } from 'bullmq';

/**
 * BullMQ increments attemptsMade after an attempt has run.  While the
 * processor is running, therefore, the current attempt is attemptsMade + 1.
 */
export function hasBullMQRetriesRemaining(job: Pick<Job, 'attemptsMade' | 'opts'>): boolean {
    const maxAttempts = Number(job.opts?.attempts ?? 1);
    const attemptsMade = Number(job.attemptsMade ?? 0);
    return Number.isFinite(maxAttempts)
        && maxAttempts > 0
        && attemptsMade + 1 < maxAttempts;
}

export function getPRCommentFailureTransition(
    job: Pick<Job, 'attemptsMade' | 'opts'>,
): { state: 'processing' | 'failed'; retryPending: boolean } {
    const retryPending = hasBullMQRetriesRemaining(job);
    return { state: retryPending ? 'processing' : 'failed', retryPending };
}
