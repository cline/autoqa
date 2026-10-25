import * as fs from "node:fs/promises";
import * as path from "node:path";

export class ScratchStorage implements AsyncDisposable {
    private readonly parentPlusPrefix: string
    private _root: fs.DisposableTempDir | undefined;

    constructor(parent: string, prefix: string) {
        this.parentPlusPrefix = path.resolve(path.join(parent, prefix));
    }

    public async root(): Promise<string> {
        if (!this._root) {
            this._root = await fs.mkdtempDisposable(this.parentPlusPrefix)
        }
        return this._root.path;
    }

    // Checks whether `s` is inside the root of this storage, and returns `s` as an absolute path.
    // `s` may be specified as a relative OR absolute path.
    public async checked(s: string): Promise<string> {
        const root = await this.root();
        console.log(root, s)
        const p = path.resolve(root, s);
        const relative = path.relative(root, p);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return p;
        }
        throw new Error(`${s} traverses outside scratch storage`);
    }

    public async newDirectory(prefix: string): Promise<string> {
        return fs.mkdtemp(await this.checked(prefix));
    }

    public async [Symbol.asyncDispose](): Promise<void> {
        if (this._root) {
            await this._root[Symbol.asyncDispose]();
            this._root = undefined;
        }
    }
}