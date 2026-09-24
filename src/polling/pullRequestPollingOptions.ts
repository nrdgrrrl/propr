/**
 * Keep polling intake bounded to open conversations. Deploy commands on a
 * merged PR require event-driven intake rather than scanning closed history.
 */
export function pullRequestPollingOptions(owner: string, repo: string) {
    return { owner, repo, state: 'open' as const, per_page: 100 };
}
