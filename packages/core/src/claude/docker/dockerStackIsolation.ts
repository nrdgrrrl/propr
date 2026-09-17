import path from 'node:path';

export const PROPR_STACK_LABEL = 'propr.stack';

const HOST_TEMP_PATH_ROOTS = [
    '/tmp/git-processor',
    '/tmp/pr-worktrees',
    '/tmp/claude-logs',
    '/tmp/propr-vibe-prompts',
] as const;

export function getProprStack(): string {
    return process.env.PROPR_STACK?.trim() || 'propr';
}

/** A named stack must never infer ownership from a container name or task label alone. */
export function requiresProprStackOwnership(): boolean {
    return getProprStack() !== 'propr';
}

export function hasProprHostTempRoot(): boolean {
    return Boolean(process.env.PROPR_HOST_TEMP_ROOT?.trim());
}

/**
 * Resolve a ProPR container temp path to its host-visible path when a private
 * host temp root is configured. The container-side path remains unchanged;
 * only the source path sent to the host Docker daemon is translated.
 */
export function resolveHostTempPath(
    containerPath: string,
    hostTempRoot = process.env.PROPR_HOST_TEMP_ROOT,
): string {
    if (!hostTempRoot?.trim()) return containerPath;
    const normalizedPath = path.posix.normalize(containerPath);
    for (const tempRoot of HOST_TEMP_PATH_ROOTS) {
        if (normalizedPath === tempRoot || normalizedPath.startsWith(`${tempRoot}/`)) {
            return path.posix.join(
                path.posix.resolve(hostTempRoot),
                path.posix.relative('/tmp', normalizedPath),
            );
        }
    }
    return containerPath;
}

function resolveVolumeSpec(spec: string): string {
    const separator = spec.indexOf(':');
    if (separator < 1) return spec;
    const source = spec.slice(0, separator);
    const resolvedSource = resolveHostTempPath(source);
    return resolvedSource === source ? spec : `${resolvedSource}${spec.slice(separator)}`;
}

function namespaceContainerName(name: string, stack: string): string {
    if (stack === 'propr' || name.startsWith(`${stack}-`)) return name;
    return `${stack}-${name}`.slice(0, 128);
}

/** Add the owning stack label and an instance prefix to named child runs. */
export function addProprStackOwnershipToDockerRunArgs(args: string[], stack = getProprStack()): string[] {
    if (args[0] !== 'run') return args;

    const result = ['run', '--label', `${PROPR_STACK_LABEL}=${stack}`];
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '--label' && args[index + 1]?.startsWith(`${PROPR_STACK_LABEL}=`)) {
            index += 1;
            continue;
        }
        if (arg.startsWith(`--label=${PROPR_STACK_LABEL}=`)) continue;
        if (arg === '-v' || arg === '--volume') {
            result.push(arg, resolveVolumeSpec(args[index + 1] ?? ''));
            index += 1;
            continue;
        }
        if (arg.startsWith('--volume=')) {
            result.push(`--volume=${resolveVolumeSpec(arg.slice('--volume='.length))}`);
            continue;
        }
        if (arg === '--name' && args[index + 1]) {
            result.push(arg, namespaceContainerName(args[index + 1]!, stack));
            index += 1;
            continue;
        }
        if (arg.startsWith('--name=')) {
            result.push(`--name=${namespaceContainerName(arg.slice('--name='.length), stack)}`);
            continue;
        }
        result.push(arg);
    }
    return result;
}
