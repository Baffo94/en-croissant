// Minimal GitHub REST client for the sync feature (Git Data API).
// The fetch implementation is injectable so the client can be tested and reused.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RepoRef = { owner: string; repo: string; branch: string };

export class GitHubError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
        this.name = "GitHubError";
    }
}

export type TreeEntry = { path: string; sha: string; type: string; mode: string };

export type NewTreeEntry = {
    path: string;
    mode: "100644";
    type: "blob";
    /** null deletes the file */
    sha: string | null;
};

const API = "https://api.github.com";

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
    const binary = atob(b64.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
}

export class GitHubClient {
    constructor(
        private token: string,
        private ref: RepoRef,
        private fetchImpl: FetchLike,
        private userAgent = "EnCroissant-sync",
    ) {}

    private get repoUrl() {
        return `${API}/repos/${encodeURIComponent(this.ref.owner)}/${encodeURIComponent(this.ref.repo)}`;
    }

    private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
        const res = await this.fetchImpl(url, {
            method,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${this.token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": this.userAgent,
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            let message = `${res.status}`;
            try {
                const data = (await res.json()) as { message?: string };
                if (data?.message) message = `${res.status} ${data.message}`;
            } catch {
                // ignore body parse errors
            }
            throw new GitHubError(message, res.status);
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
    }

    /** Repository info; throws GitHubError(404) if the token can't see it. */
    async getRepo(): Promise<{
        private: boolean;
        permissions?: { push?: boolean };
        default_branch: string;
    }> {
        return this.request("GET", this.repoUrl);
    }

    /** Commit sha at the head of the branch, or null if the branch (or the whole repo) is empty. */
    async getHead(): Promise<string | null> {
        try {
            const data = await this.request<{ object: { sha: string } }>(
                "GET",
                `${this.repoUrl}/git/ref/heads/${encodePath(this.ref.branch)}`,
            );
            return data.object.sha;
        } catch (e) {
            // 404: branch missing, 409: repository empty
            if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
            throw e;
        }
    }

    async getCommitTree(commitSha: string): Promise<string> {
        const data = await this.request<{ tree: { sha: string } }>(
            "GET",
            `${this.repoUrl}/git/commits/${commitSha}`,
        );
        return data.tree.sha;
    }

    async getTree(treeSha: string): Promise<TreeEntry[]> {
        const data = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
            "GET",
            `${this.repoUrl}/git/trees/${treeSha}?recursive=1`,
        );
        if (data.truncated) throw new Error("Repository too large to sync");
        return data.tree.filter((e) => e.type === "blob");
    }

    async getBlob(sha: string): Promise<Uint8Array> {
        const data = await this.request<{ content: string; encoding: string }>(
            "GET",
            `${this.repoUrl}/git/blobs/${sha}`,
        );
        if (data.encoding !== "base64")
            throw new Error(`Unexpected blob encoding ${data.encoding}`);
        return fromBase64(data.content);
    }

    async createBlob(content: Uint8Array): Promise<string> {
        const data = await this.request<{ sha: string }>("POST", `${this.repoUrl}/git/blobs`, {
            content: toBase64(content),
            encoding: "base64",
        });
        return data.sha;
    }

    async createTree(baseTree: string | null, entries: NewTreeEntry[]): Promise<string> {
        const data = await this.request<{ sha: string }>("POST", `${this.repoUrl}/git/trees`, {
            ...(baseTree ? { base_tree: baseTree } : {}),
            tree: entries,
        });
        return data.sha;
    }

    async createCommit(message: string, tree: string, parent: string | null): Promise<string> {
        const data = await this.request<{ sha: string }>("POST", `${this.repoUrl}/git/commits`, {
            message,
            tree,
            parents: parent ? [parent] : [],
        });
        return data.sha;
    }

    /** Moves the branch to `sha`. Fails with GitHubError(422) if someone else pushed meanwhile. */
    async updateHead(sha: string): Promise<void> {
        await this.request(
            "PATCH",
            `${this.repoUrl}/git/refs/heads/${encodePath(this.ref.branch)}`,
            {
                sha,
                force: false,
            },
        );
    }

    /**
     * Creates the branch. On a completely empty repository the Git Data API is not
     * available, so the first commit is made with the Contents API.
     */
    async initBranch(): Promise<string> {
        const data = await this.request<{ commit: { sha: string } }>(
            "PUT",
            `${this.repoUrl}/contents/README.md`,
            {
                message: "Initialize En Croissant sync",
                content: toBase64(
                    new TextEncoder().encode(
                        "# En Croissant sync\n\nRepertoires (`repertoires/`) and practice progress (`progress/`) synced by En Croissant.\n",
                    ),
                ),
                branch: this.ref.branch,
            },
        );
        return data.commit.sha;
    }
}

export const __test = { toBase64, fromBase64 };
