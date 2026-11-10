export const GUILD_CHAT_PATTERN =
    /^Guild >\s+(?:(\[[^\]\r\n]+\])\s+)?([A-Za-z0-9_]{1,16}):\s?(.*)$/;

export const singleLine = (value: string) =>
    value
        .replace(/[\r\n\t]+/g, ' ')
        // Strip Minecraft-invalid control characters from untrusted chat text.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f\u00a7]/g, '')
        .trim();

export function formatGuildMessage(name: string, message: string, separator: string) {
    const author = singleLine(name);
    const content = singleLine(message);
    if (!author || !content) throw new Error('The message must contain text.');
    return `${author} ${singleLine(separator)} ${content}`;
}

export function guildCommand(command: string, message: string) {
    const content = singleLine(message);
    if (!content) throw new Error('The message must contain text.');
    const result = `${command} ${content}`;
    if (result.length > 256) {
        throw new Error(
            `The message is too long for Minecraft (${result.length}/256 characters including the command and name).`
        );
    }
    return result;
}
