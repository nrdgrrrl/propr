/** Build a task detail URL with the task ID contained in a single path segment. */
export const taskDetailsPath = (taskId: string): string => `/tasks/${encodeURIComponent(taskId)}`;
