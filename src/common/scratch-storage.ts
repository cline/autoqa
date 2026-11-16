import * as fs from "node:fs/promises";
import * as path from "node:path";

export class ScratchStorage implements AsyncDisposable {
    private readonly parentPlusPrefix: string | undefined;
    private readonly existingRoot: string | undefined;
    private _root: Promise<fs.DisposableTempDir> | undefined;

    constructor(parent: string, prefix: string, existingRoot?: string) {
        if (existingRoot) {
            this.existingRoot = path.resolve(existingRoot);
        } else {
            this.parentPlusPrefix = path.resolve(path.join(parent, prefix));
        }
    }

    public static existing(rootPath: string): ScratchStorage {
        return new ScratchStorage('', '', rootPath);
    }

    public async root(): Promise<string> {
        if (this.existingRoot) {
            return this.existingRoot;
        }
        if (!this._root) {
            this._root = fs.mkdtempDisposable(this.parentPlusPrefix!);
        }
        return (await this._root).path;
    }

    // Checks whether `s` is inside the root of this storage, and returns `s` as an absolute path.
    // `s` may be specified as a relative OR absolute path.
    public async checked(s: string): Promise<string> {
        const root = await this.root();
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
        const pending = this._root;
        if (pending) {
            this._root = undefined;
            const dir = await pending;
            await dir[Symbol.asyncDispose]();
        }
    }
}