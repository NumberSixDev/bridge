export default async function withTimeout<T>(
    operation: Promise<T>,
    milliseconds: number,
    message: string,
    onTimeout?: () => void
): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(message));
                    onTimeout?.();
                }, milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
