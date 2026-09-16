/**
 * BullMQ emits a failed event for every failed attempt, including attempts
 * that will be retried. The repository must remain indexing until the final
 * attempt has failed, otherwise the periodic scanner can enqueue duplicates.
 */
export function hasPendingIndexingRetry(attemptsMade: number, maxAttempts = 1): boolean {
    return attemptsMade < maxAttempts;
}
