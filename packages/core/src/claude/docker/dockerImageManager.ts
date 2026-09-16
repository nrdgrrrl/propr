import logger from '../../utils/logger.js';
import { executeDockerCommand } from './dockerExecutor.js';
import { AGENT_IMAGE_NAME } from '../../agents/version/types.js';

const AGENT_BUNDLE_LABEL = 'dev.propr.agent-bundle';

interface DockerImageMetadata {
    id: string;
    labels: Record<string, string>;
}

async function listRunningImageIds(): Promise<Set<string> | null> {
    const listed = await executeDockerCommand('docker', [
        'ps', '-q', '--no-trunc'
    ], { timeout: 30000 });
    if (listed.exitCode !== 0) {
        logger.warn({ stderr: listed.stderr.trim() }, 'Unable to verify running Docker images; skipping agent image cleanup');
        return null;
    }

    const containerIds = listed.stdout.split('\n').map(value => value.trim()).filter(Boolean);
    if (containerIds.length === 0) return new Set();

    const inspected = await executeDockerCommand('docker', [
        'inspect', '--format', '{{.Image}}', ...containerIds
    ], { timeout: 30000 });
    if (inspected.exitCode !== 0) {
        logger.warn({ stderr: inspected.stderr.trim() }, 'Unable to inspect running Docker images; skipping agent image cleanup');
        return null;
    }

    return new Set(inspected.stdout.split('\n').map(value => value.trim()).filter(Boolean));
}

async function inspectAgentImage(imageTag: string): Promise<DockerImageMetadata | null> {
    const result = await executeDockerCommand('docker', [
        'image', 'inspect', `${AGENT_IMAGE_NAME}:${imageTag}`,
        '--format', '{{json .}}'
    ], { timeout: 30000 });
    if (result.exitCode !== 0) {
        logger.warn({ imageTag, stderr: result.stderr.trim() }, 'Unable to inspect agent image; leaving it untouched');
        return null;
    }

    try {
        const metadata = JSON.parse(result.stdout.trim()) as {
            Id?: unknown;
            Config?: { Labels?: unknown };
        };
        if (typeof metadata.Id !== 'string' || !metadata.Id.trim()) return null;
        const labels = metadata.Config?.Labels;
        return {
            id: metadata.Id,
            labels: labels && typeof labels === 'object' && !Array.isArray(labels)
                ? Object.fromEntries(Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
                : {}
        };
    } catch (error) {
        logger.warn({ imageTag, error: (error as Error).message }, 'Unable to parse agent image metadata; leaving it untouched');
        return null;
    }
}


/**
 * Lists all unified agent Docker image tags.
 *
 * @returns Array of image tags (e.g., ['2.1.77-a3f2b1', '2.1.76-b4c3d2'])
 */
export async function listAgentImages(): Promise<string[]> {
    try {
        const result = await executeDockerCommand('docker', [
            'images', AGENT_IMAGE_NAME, '--format', '{{.Tag}}'
        ]);

        const tags = result.stdout
            .trim()
            .split('\n')
            .filter(tag => tag && tag !== '<none>');

        return tags;
    } catch (error) {
        logger.warn({ error: (error as Error).message }, 'Failed to list agent images');
        return [];
    }
}

/**
 * Cleans up unused unified agent Docker images.
 * Keeps images that are currently in use by agent configs and the default version.
 * Managed unified bundles are retained until a future cleanup mechanism can
 * prove that they are stale for every isolated ProPR stack. The cleanup hook
 * runs in one stack but operates on the host-wide Docker image namespace, so a
 * tag absent from this process's config is not evidence that it is unused.
 *
 * @param tagsInUse - Set of image tags currently in use (optional, will be fetched if not provided)
 * @returns Number of images deleted
 */
export async function cleanupUnusedAgentImages(
    tagsInUse?: Set<string>
): Promise<number> {
    try {
        // Get all image tags for this agent
        const allTags = await listAgentImages();

        if (allTags.length === 0) {
            return 0;
        }

        // If versionsInUse not provided, don't delete anything (safe default)
        if (!tagsInUse || tagsInUse.size === 0) {
            logger.debug('No versions specified to keep, skipping cleanup');
            return 0;
        }

        // Always keep 'latest' tag
        const tagsToKeep = new Set(tagsInUse);
        tagsToKeep.add('latest');
        const runningImageIds = await listRunningImageIds();
        if (!runningImageIds) return 0;

        let deletedCount = 0;

        for (const tag of allTags) {
            if (tagsToKeep.has(tag)) {
                continue;
            }

            const metadata = await inspectAgentImage(tag);
            if (!metadata) continue;

            // Every image produced by Dockerfile.agent carries this label. It
            // is the only reliable provenance marker available to a cleanup
            // process that may be running for either isolated stack. Keeping
            // these bundles prevents a startup race from deleting a valid
            // candidate or the other stack's configured rollback image.
            if (metadata.labels[AGENT_BUNDLE_LABEL] === 'true') {
                logger.debug({ imageTag: `${AGENT_IMAGE_NAME}:${tag}` }, 'Keeping managed agent bundle during stack-safe cleanup');
                continue;
            }

            // Inspect before rmi so a running container can never be the
            // reason an image is selected for deletion. Docker also rejects
            // removal of parent images used by derived runtime images, but we
            // fail closed here instead of relying on that incidental behavior.
            if (runningImageIds.has(metadata.id)) {
                logger.debug({ imageTag: `${AGENT_IMAGE_NAME}:${tag}`, imageId: metadata.id }, 'Keeping agent image used by a running container');
                continue;
            }

            // Delete the image
            const fullImageName = `${AGENT_IMAGE_NAME}:${tag}`;
            logger.info({ imageTag: fullImageName }, 'Deleting unused agent Docker image');

            try {
                await executeDockerCommand('docker', ['rmi', fullImageName]);
                deletedCount++;
                logger.info({ imageTag: fullImageName }, 'Deleted unused agent Docker image');
            } catch (deleteError) {
                // Image might be in use by a container, skip
                logger.debug({
                    imageTag: fullImageName,
                    error: (deleteError as Error).message
                }, 'Could not delete image (may be in use)');
            }
        }

        logger.info({ deletedCount }, 'Cleanup completed');
        return deletedCount;

    } catch (error) {
        logger.error({ error: (error as Error).message }, 'Failed to cleanup unused agent images');
        return 0;
    }
}
