export const protocolVersion = 1 as const;
export const maximumMessageBytes = 64 * 1024;

export type StatusResult = {
  state: "healthy" | "attention" | "offline";
  lastPollAt: string | null;
  allowlistedRepoCount: number;
  pendingApprovalCount: number;
  errorCount: number;
};

export type ApiRequest = {
  v: number;
  id: string;
  method: "status";
  params?: Record<string, never>;
};

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
  result: StatusResult;
};

export type ApiResponse = ApiFailure | ApiSuccess;

export function failure(id: string | null, code: string, message: string): ApiFailure {
  return { v: protocolVersion, id, ok: false, error: { code, message } };
}
