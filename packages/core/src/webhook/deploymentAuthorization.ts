/** Deployment uses the configured allowlist as an explicit authorization boundary. */
export function isDeploymentCommentAuthorized(
    username: string,
    userType: string | null | undefined,
    configuredWhitelist: string[] | undefined,
): boolean {
    if (userType?.toLowerCase() === 'bot' || username.toLowerCase().includes('[bot]')) return false;
    const allowed = (configuredWhitelist ?? []).map(value => value.trim().toLowerCase()).filter(Boolean);
    return allowed.length > 0 && allowed.includes(username.trim().toLowerCase());
}
