export interface RankingValue {
    username: string;
    value: number;
}

export function compareRankingValues(left: RankingValue, right: RankingValue) {
    if (right.value !== left.value) return right.value - left.value;
    return (
        left.username.toLowerCase().localeCompare(right.username.toLowerCase()) ||
        left.username.localeCompare(right.username)
    );
}

export function sortRankingValues<T extends RankingValue>(values: T[]) {
    return [...values].sort(compareRankingValues);
}

export function rankingPosition(username: string, values: RankingValue[]) {
    const sorted = sortRankingValues(values);
    const position = sorted.findIndex(
        (value) => value.username.toLowerCase() === username.toLowerCase()
    );
    return position < 0 ? undefined : { position: position + 1, rankedMembers: sorted.length };
}
