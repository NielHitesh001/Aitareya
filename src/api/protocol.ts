export const protocolVersion = 1 as const;
export const maximumMessageBytes = 64 * 1024;

export type StatusResult = {
  state: "healthy" | "attention" | "offline";
  lastPollAt: string | null;
  allowlistedRepoCount: number;
  pendingApprovalCount: number;
  errorCount: number;
};

export type RepoSocketState = "upToDate" | "behind" | "ahead" | "diverged" | "dirty" | "missing";

export type RepoStatusItem = {
  name: string;
  path: string | null;
  branch: string;
  state: RepoSocketState;
  ahead: number;
  behind: number;
  dirty: boolean;
  lastFetch: string | null;
  prState: string;
};

export type ReposStatusResult = {
  repos: RepoStatusItem[];
  counts: {
    upToDate: number;
    behind: number;
    ahead: number;
    diverged: number;
    dirty: number;
    missing: number;
  };
  lastSuccessfulPoll: string | null;
};

export type ReposPullResult = {
  repo: string;
  status: "updated" | "up_to_date" | "diverged" | "skipped" | "failed";
  line: string;
};

export type ApiRequest =
  | { v: number; id: string; method: "status"; params?: Record<string, never> }
  | { v: number; id: string; method: "repos.status"; params?: Record<string, never> }
  | { v: number; id: string; method: "repos.pull"; params: { repo: string } };

export type ApiFailure = {
  v: typeof protocolVersion;
  id: string | null;
  ok: false;
  error: { code: string; message: string };
};

export type ApiSuccess = {
  v: typeof protocolVersion;
  id: string;
  ok: true;
  result: StatusResult | ReposStatusResult | ReposPullResult;
};

export type ApiResponse = ApiFailure | ApiSuccess;

export function failure(id: string | null, code: string, message: string): ApiFailure {
  return { v: protocolVersion, id, ok: false, error: { code, message } };
}
