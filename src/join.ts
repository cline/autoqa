// Micro join calculus kernel.
//
// See https://gist.github.com/dominiccooney/684df525701daac2be99efc787d0fec3
// for an example.

const ready = Symbol('ready');
const take = Symbol('take');
const evaluate = Symbol('evaluate');
export const joinery = Symbol('joinery');

export interface Mailbox<T> {
    (actual: T): void;
    readonly [ready]: boolean;
    [take](): T;
}

type Formals<Ms extends readonly Mailbox<any>[]> = {
    [K in keyof Ms]: Ms[K] extends Mailbox<infer T> ? T : never;
}

export class Joinery {
    private patterns: [ms: readonly Mailbox<any>[], body: (...actuals: any) => void][] = []

    m<T>(): Mailbox<T> {
        const actuals: T[] = [];
        const post = (actual: T): void => {
            const wasEmpty = actuals.length === 0;
            actuals.push(actual);
            if (wasEmpty) {
                this[evaluate](post as Mailbox<T>);
            }
        }
        return Object.defineProperties(post, {
            [ready]: {get: () => actuals.length > 0 },
            [take]: {value: () => {
                    if (actuals.length === 0) {
                        throw new Error('take from empty mailbox');
                    }
                    return actuals.shift()!;
            }},
        }) as Mailbox<T>;
    }

    on<const Ms extends readonly Mailbox<any>[]>(
        mailboxes: Ms,
        body: (...actuals: Formals<Ms>) => void,
    ): void {
        if (mailboxes.length === 0) {
            throw new Error('patterns must have at least one mailbox');
        }
        for (let i = 1; i < mailboxes.length; i++) {
            for (let j = 0; j < i; j++) {
                if (mailboxes[i] === mailboxes[j]) {
                    throw new Error('mailboxes must only appear once in a pattern');
                }
            }
        }
        this.patterns.push([mailboxes, body])
    }

    [evaluate](_m: Mailbox<any>): void {
        // TODO: We could evaluate the subset of patterns which mention this mailbox using _m.
        for (const [pattern, body] of this.patterns) {
            if (pattern.every(mailbox => mailbox[ready])) {
                // This is weakly typed; see how "on" ensures mailboxes and bodies line up.
                const actuals = pattern.map(mailbox => mailbox[take]());
                // TODO: We don't return this Promise to encourage use of joins instead.
                // However we could gave a joinery-wide Promise for quiescence.
                void Promise.resolve().then(() => {
                    body.apply(undefined, actuals);
                });
                return;
            }
        }
    }
}
