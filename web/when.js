// Masked accounts (T12e): the API masks real handles ("ac***"), so the posts of several accounts can carry one author.

/** Can the group's accounts not be told apart? Then nothing may be counted or drawn per account. */
export const merged = (accounts, items) => new Set(items.map(it => it.author)).size < (accounts?.length ?? 0);
