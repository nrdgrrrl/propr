import path from 'node:path';

const GIT_PROCESSOR_TEMP_ROOT = '/tmp/git-processor';

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
    if (normalizedPath === GIT_PROCESSOR_TEMP_ROOT || normalizedPath.startsWith(`${GIT_PROCESSOR_TEMP_ROOT}/`)) {
        return path.posix.join(
            path.posix.resolve(hostTempRoot),
            path.posix.relative('/tmp', normalizedPath),
        );
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

/** Translate host-side bind sources in a Docker run command. */
export function resolveDockerRunHostPaths(args: string[]): string[] {
    if (args[0] !== 'run') return args;

    const result = ['run'];
    for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '-v' || arg === '--volume') {
            result.push(arg, resolveVolumeSpec(args[index + 1] ?? ''));
            index += 1;
            continue;
        }
        if (arg.startsWith('--volume=')) {
            result.push(`--volume=${resolveVolumeSpec(arg.slice('--volume='.length))}`);
            continue;
        }
        result.push(arg);
    }
    return result;
}
